import { getStore } from '@netlify/blobs';

async function main() {
  console.log('Connecting to Netlify Blobs store "kesha"...');
  
  try {
    const store = getStore('kesha');
    console.log('Clearing "previous-intros" store...');
    await store.setJSON('previous-intros', []);
    console.log('✅ Successfully cleared "previous-intros" store (set to []).');
  } catch (err) {
    console.error('Failed to clear "previous-intros":', err);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
