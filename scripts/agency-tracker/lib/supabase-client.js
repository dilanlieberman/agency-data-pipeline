const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function upsert(table, data, onConflict) {
  const { error, data: result } = await supabase
    .from(table)
    .upsert(data, { onConflict });
  if (error) throw new Error(error.message);
  return result;
}

async function upsertSetterDaily(row) {
  return upsert('setter_daily', row, 'setter_name,date');
}

async function upsertCloserDaily(row) {
  return upsert('closer_daily', row, 'date');
}

async function upsertPpaClientDaily(row) {
  return upsert('ppa_client_daily', row, 'client_name,date');
}

async function upsertRetainerClient(row) {
  return upsert('retainer_client', row, 'client_name');
}

async function upsertBuilderPipeline(row) {
  return upsert('builder_pipeline', row, 'builder_name');
}

async function upsertAgencyDaily(row) {
  return upsert('agency_daily', row, 'date');
}

async function insertAlert(row) {
  const { error, data: result } = await supabase
    .from('alerts')
    .insert(row);
  if (error) throw new Error(error.message);
  return result;
}

module.exports = {
  supabase,
  upsert,
  upsertSetterDaily,
  upsertCloserDaily,
  upsertPpaClientDaily,
  upsertRetainerClient,
  upsertBuilderPipeline,
  upsertAgencyDaily,
  insertAlert,
};
