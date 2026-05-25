#!/usr/bin/env node
// Downloads video ads (Facebook Reels) via yt-dlp, transcribes via OpenAI Whisper,
// upserts into meta_ad_transcripts. Idempotent — skips ads already transcribed.
//
// Run once to backfill + hourly cron to catch new ads. Costs ~$0.006/min of video.

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { createClient } = require('@supabase/supabase-js');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

const exec = promisify(execFile);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function downloadVideo(videoId, tmpDir) {
  const outPath = path.join(tmpDir, `${videoId}.%(ext)s`);
  // yt-dlp on the reel URL — works for the Pinnacle ad account's Facebook Reels.
  await exec('yt-dlp', [
    '-o', outPath,
    '--no-warnings',
    '--quiet',
    `https://www.facebook.com/reel/${videoId}/`,
  ], { timeout: 120000 });
  // Resolve actual filename (yt-dlp may pick mp4 or other)
  const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith(`${videoId}.`));
  if (!files.length) throw new Error('yt-dlp produced no output');
  return path.join(tmpDir, files[0]);
}

async function extractAudio(videoPath, tmpDir, videoId) {
  const audioPath = path.join(tmpDir, `${videoId}.mp3`);
  await exec('ffmpeg', [
    '-y', '-i', videoPath,
    '-vn', '-acodec', 'libmp3lame', '-ar', '16000', '-ac', '1', '-b:a', '64k',
    audioPath,
  ], { timeout: 60000 });
  return audioPath;
}

async function whisperTranscribe(audioPath) {
  // Use multipart/form-data via node native fetch + FormData
  const data = new FormData();
  data.append('file', new Blob([fs.readFileSync(audioPath)]), path.basename(audioPath));
  data.append('model', 'whisper-1');
  data.append('response_format', 'text');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: data,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Whisper API ${res.status}: ${errText.slice(0, 200)}`);
  }
  return (await res.text()).trim();
}

async function findAdsToTranscribe() {
  // Pull ads with creative_video_id that aren't yet in meta_ad_transcripts.
  // Use account_id = Pinnacle's for now; remove the filter to backfill clients too.
  const { data: ads, error: adsErr } = await supabase
    .from('meta_ad_snapshot')
    .select('ad_id, creative_video_id, ad_name')
    .eq('account_id', 'act_25010776835219106')
    .eq('date_preset', 'maximum')
    .not('creative_video_id', 'is', null);
  if (adsErr) throw new Error(`ads query: ${adsErr.message}`);

  const { data: existing, error: existingErr } = await supabase
    .from('meta_ad_transcripts')
    .select('ad_id');
  if (existingErr) throw new Error(`existing query: ${existingErr.message}`);

  const have = new Set((existing || []).map((r) => r.ad_id));
  return (ads || []).filter((a) => !have.has(a.ad_id));
}

async function processAd(ad, tmpDir) {
  let videoPath, audioPath;
  try {
    videoPath = await downloadVideo(ad.creative_video_id, tmpDir);
    audioPath = await extractAudio(videoPath, tmpDir, ad.creative_video_id);
    const transcript = await whisperTranscribe(audioPath);
    const stat = fs.statSync(videoPath);
    const { error } = await supabase.from('meta_ad_transcripts').upsert({
      ad_id: ad.ad_id,
      video_id: ad.creative_video_id,
      transcript,
      transcribed_at: new Date().toISOString(),
    }, { onConflict: 'ad_id' });
    if (error) throw new Error(`upsert: ${error.message}`);
    return { ok: true, transcript_len: transcript.length, video_bytes: stat.size };
  } finally {
    for (const p of [videoPath, audioPath]) {
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    }
  }
}

async function main() {
  const t0 = Date.now();
  const ads = await findAdsToTranscribe();
  console.log(`meta-ad-transcript-sync — ${ads.length} ads to transcribe`);
  if (ads.length === 0) {
    console.log('  nothing to do.');
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinnacle-transcripts-'));
  let okCount = 0;
  let failCount = 0;
  for (const ad of ads) {
    process.stdout.write(`  → ${ad.ad_name?.slice(0, 50)} (${ad.creative_video_id})... `);
    try {
      const r = await processAd(ad, tmpDir);
      okCount += 1;
      console.log(`✓ ${r.transcript_len} chars`);
    } catch (e) {
      failCount += 1;
      console.log(`✗ ${e.message}`);
    }
  }
  // Best-effort cleanup of tmpDir
  try { fs.rmdirSync(tmpDir, { recursive: true }); } catch {}
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`meta-ad-transcript-sync ✓ ${okCount} transcribed | ${failCount} failed | ${dt}s`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('meta-ad-transcript-sync FAIL:', e.message);
    process.exit(1);
  });
}

module.exports = { main, findAdsToTranscribe, processAd };
