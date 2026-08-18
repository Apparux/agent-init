const endpoint = '/health';

async function main() {
  if (!process.env.STAGING_URL) throw new Error('STAGING_URL is required');
  const response = await fetch(new URL(endpoint, process.env.STAGING_URL));
  if (!response.ok) throw new Error(`staging health check failed: ${response.status}`);
  console.log(`staging health check passed for ${endpoint}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
