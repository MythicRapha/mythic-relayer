// Check L2 bridge initialization status
const { PublicKey, Connection } = require('@solana/web3.js');

const PROG = new PublicKey('MythBrdgL2111111111111111111111111111111111');
const PROG2 = new PublicKey('5t8JwXzGQ3c7PCY6p6oJqZgFt8gff2d6uTLrqa1jFrKP');

async function check(label, progId) {
  const conn = new Connection('http://127.0.0.1:8899');
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('l2_bridge_config')], progId);
  const [reservePda] = PublicKey.findProgramAddressSync([Buffer.from('bridge_reserve')], progId);
  
  console.log(`\n=== ${label} (${progId.toBase58()}) ===`);
  console.log('Config PDA:', configPda.toBase58());
  console.log('Reserve PDA:', reservePda.toBase58());
  
  const configAcct = await conn.getAccountInfo(configPda);
  const reserveBal = await conn.getBalance(reservePda);
  
  console.log('Config exists:', !!configAcct);
  if (configAcct) {
    console.log('Config data length:', configAcct.data.length);
    console.log('Config owner:', configAcct.owner.toBase58());
  }
  console.log('Reserve balance:', reserveBal / 1e9, 'MYTH');
}

async function main() {
  await check('Vanity L2 Bridge', PROG);
  await check('Upgradeable L2 Bridge', PROG2);
}

main().catch(console.error);
