// ad-copy-variants.js — single source of truth for the ad copy concepts
// that live in 11-leadgen-campaign.js. The variants here mirror that file's
// `buildCopyVariants()` output but with placeholder substitution applied
// inline at lookup time so the dashboard can render real preview text
// using whatever business_name we already have on the snapshot row.
//
// matchConcept(adName) returns the canonical key (i_know | dirty_little_secret |
// cheapest_in_town | stress_free | construction_zone) when ad_name contains
// the concept's signature, otherwise null. Matching is intentionally loose:
// the operator names ads inconsistently ("4 Collage 2 | Image| I know",
// "4 Collage | Image | Stress Free", etc.) so we look for any signature
// substring.

const VARIANTS = {
  i_know: {
    name: "I Know",
    primary:
      "I know...\n\n$9,500 for a bathroom plus a FREE Faucet Upgrade?\n\nThat's crazy.\n\nBathrooms are like $20K usually.\n\nRight?\n\nSort of...\n\nBut not really.\n\nIt depends on the size, the layout, and the finishes.\n\nThing is...\n\nThere's a fair price.\n\nAnd then there's pricing so insanely ridiculous that I don't know how some remodelers sleep at night.\n\nMy name is {client_first_name} and I own {business_name}.\n\nHere's how I run my business:\n\nFirst and foremost, I do amazing work.\n\nI don't settle for anything less.\n\nNo corner cutting.\n\nNo junky materials.\n\nAnd I only work with my crews.\n\nBut there's more...\n\nBecause I'm a small company that I run really well, I don't have a ton of overhead.\n\nUnlike the big bloated companies who have fancy offices and TV commercials and billboards...\n\nGuess who pays for all of that?\n\nYup... YOU.\n\nThat's not at all how I roll.\n\nSo, I can do something really awesome:\n\nI can do amazing work.\n\nInstall bathrooms that are gorgeous and built to last.\n\nWITHOUT charging you 200% more than it should really cost.\n\nThe best work, the best materials, at fair prices.\n\nSo you can not only have peace of mind, but also save money.\n\nSimple.\n\nClick here now and let's talk:\n\n{funnel_url}",
    headline: "Get A New Bathroom Starting at $9,500",
    description: "⭐⭐⭐⭐⭐ {business_name}",
    // Match if ad_name contains any of these (case-insensitive).
    signatures: ["i know"],
  },
  dirty_little_secret: {
    name: "Dirty Little Secret",
    primary:
      "Want to know a dirty little secret about bathroom remodeling?\n\n99 times out of 100, you're paying the commission of a sales person.\n\nWhich is why with us you get a new bathroom for thousands less, because we cut out that middle man—the sales person.\n\nInstead, you deal directly with the owner.\n\nMy name is {client_first_name} and I own {business_name}.\n\nWhen you need a new bathroom, you talk directly to me.\n\nAnd therefore you SAVE!\n\nPlus, since I'm the owner, I know more about our products and services than a salesperson ever could.\n\nSo not only do you save money, but you get the hands-on help you need to choose the perfect materials for your project based on the look and feel you want, your budget, etc...\n\nClick here now and get a free, fast quote for a new, gorgeous bathroom for the BEST VALUE in all of {service_area}: {funnel_url}",
    headline: "Save Thousands on Bathroom Remodeling with Owner Direct Pricing",
    description: "Best remodeling in {service_area}, hands down!",
    signatures: ["dirty little secret", "dirty_little_secret", "dirty lil", "dls"],
  },
  cheapest_in_town: {
    name: "Cheapest In Town",
    primary:
      "Are we the cheapest in town?\n\nNo.\n\nThe cheapest guys in town will give you a bathroom that starts falling apart in two years because they rushed the job and used bargain bin materials.\n\nAre we the most expensive?\n\nNot even close.\n\nThe most expensive guys pad their quotes with unnecessary add-ons you don't actually need just so they can cover all their overhead.\n\nHere's what we actually do...\n\nWe use the exact same premium materials as the high-end companies, but we don't have fancy offices or a fleet of company trucks to pay for.\n\nJust honest work, fair pricing, and a bathroom that'll last for decades.\n\nWe've been doing this for 12 years and our customers keep referring their neighbors for a reason.\n\nReady to see what a fair price looks like?\n\nClick here now and let's talk:\n\n{funnel_url}",
    headline: "Get A New Bathroom Starting at $9,500",
    description: "⭐⭐⭐⭐⭐ {business_name}",
    signatures: ["cheapest"],
  },
  stress_free: {
    name: "Stress Free",
    primary:
      "You don't need a bigger house - just a better bathroom.\n\nThe worst part of any home remodeling isn't the price.\n\nIt's the stress that comes with it.\n\nHere's how it often plays out:\n\nYou hire someone to remodel your bathroom, and then the nightmare begins.\n\nWeeks of indecision, frustrating back-and-forth, and constant second-guessing.\n\nAnd that's before the workers even show up.\n\nOnce they start, you're left with an unusable bathroom, and suddenly, it's radio silence from your contractor.\n\nYou call, you wait, and you wonder \"will this ever get done?\"\n\nHere's the truth:\n\nMost contractors don't have a process.\n\nThey wing it.\n\nAnd that's exactly why remodels spiral into chaos, delays, and budget overruns.\n\nBut imagine this instead:\n\nA smooth, efficient design process where you feel confident in every decision.\n\nA remodel that stays on time and on budget.\n\nA stress-free experience that leaves you saying, \"Wow, that was easy!\"\n\nThat's what we deliver.\n\nEvery. Single. Time.\n\nReady for a bathroom remodel without the hassle? Click \"Learn more\" below>>>>>",
    headline: "Stress-Free Remodeling at Fair Prices.",
    description: "Bathroom remodeling minus the stress without paying more",
    signatures: ["stress free", "stress_free", "stress-free"],
  },
  construction_zone: {
    name: "Construction Zone",
    primary:
      "We've all been there before...\n\nYou hire a bathroom contractor and suddenly you're living in a construction zone for 4 months.\n\n\"Just a few more days\" turns into \"just a few more weeks\" turns into you showering at Planet Fitness…\n\nThe guy who seemed so professional during the estimate now won't return your calls…\n\nYour beautiful bathroom vision has become a half-demolished nightmare with exposed pipes and a toilet sitting in your hallway.\n\nNow how do we avoid that?\n\nI'll tell ya how…\n\nWe don't start until everything is ordered and our schedule is completely clear.\n\nNo \"oops, the tile is backordered\" surprises three weeks into your project…\n\nWe then sit down with you and walk through every single step, day by day, so you know exactly what's happening with your remodel and in what timeframe.\n\nNo guessing, no wondering if we're ever coming back.\n\nWe work on one bathroom at a time, not juggling 6 jobs and hoping nothing goes wrong…\n\nYour project gets our full attention until it's done.\n\nSo if you want a good quality bathroom remodel and pricing that is not expensive, not cheap, but fair…Then click here now and let's talk: {funnel_url}",
    headline: "Stress-Free Bathroom Remodeling at Fair Prices.",
    description: "Bathroom remodeling minus the stress without paying more",
    signatures: ["construction zone", "construction_zone"],
  },
};

function matchConcept(adName) {
  if (!adName) return null;
  const lower = adName.toLowerCase();
  for (const [key, v] of Object.entries(VARIANTS)) {
    if (v.signatures.some((sig) => lower.includes(sig))) return key;
  }
  return null;
}

// Substitute placeholders with whatever we have. Anything we don't have
// stays as a labelled placeholder so the operator can still see the shape.
function substitute(text, vars) {
  if (!text) return text;
  return text
    .replace(/\{business_name\}/g, vars.business_name || "{business_name}")
    .replace(/\{client_first_name\}/g, vars.client_first_name || "{client_first_name}")
    .replace(/\{service_area\}/g, vars.service_area || "{service_area}")
    .replace(/\{funnel_url\}/g, vars.funnel_url || "{funnel_url}");
}

// Resolve copy for a given ad row. Returns null when no concept matches —
// the caller decides whether to show "—" or pull from Meta API later.
function resolveAdCopy({ ad_name, business_name }) {
  const key = matchConcept(ad_name);
  if (!key) return null;
  const v = VARIANTS[key];
  return {
    concept_key: key,
    concept_name: v.name,
    primary_text: substitute(v.primary, { business_name }),
    headline: substitute(v.headline, { business_name }),
    description: substitute(v.description, { business_name }),
  };
}

module.exports = { VARIANTS, matchConcept, resolveAdCopy };
