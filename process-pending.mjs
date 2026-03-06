#!/usr/bin/env node
/**
 * Process 13 pending bridge deposits from bridge reserve.
 * Nonces 0-10 (early deposits): 21,000 MYTH per 0.01 SOL
 * Nonce ~36 (0.01 SOL later): 5,034 MYTH
 * Nonce ~37 (0.1 SOL later): 34,206 MYTH
 */
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import { readFileSync } from 'fs';
import Database from 'better-sqlite3';

const conn = new Connection('http://localhost:8899', 'confirmed');
const BRIDGE_L2 = new PublicKey('MythBrdgL2111111111111111111111111111111111');
const sequencer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('/mnt/data/mythic-l2/keys/sequencer-identity.json', 'utf8'))));
const [configPDA] = PublicKey.findProgramAddressSync([Buffer.from('l2_bridge_config')], BRIDGE_L2);
const [reservePDA] = PublicKey.findProgramAddressSync([Buffer.from('bridge_reserve')], BRIDGE_L2);

function hexToPubkey(hex) {
  const bytes = Buffer.from(hex, 'hex');
  return new PublicKey(bytes);
}

// Read pending deposits from DB
const db = new Database('/mnt/data/mythic-relayer/data/relayer.db');
const pending = db.prepare("SELECT * FROM deposits WHERE status != 'completed' AND asset = 'SOL' ORDER BY created_at").all();
console.log(`Found ${pending.length} pending SOL deposits\n`);

// Categorize: early deposits (retry_count=0) vs later (retry_count=1)
let adminNonce = 10010; // Continue from where top-ups left off

for (let i = 0; i < pending.length; i++) {
  const dep = pending[i];
  const solAmount = dep.amount_lamports / 1e9;
  const recipient = hexToPubkey(dep.recipient_l2);
  const isLater = dep.retry_count > 0;
  
  let mythAmount;
  if (isLater && solAmount >= 0.09) {
    // 0.1 SOL later deposit (nonce ~37)
    mythAmount = 34206.2697;
  } else if (isLater) {
    // 0.01 SOL later deposit (nonce ~36)
    mythAmount = 5034.0161;
  } else {
    // Early deposit (nonces 0-10) at original era rate ~21,000 MYTH per 0.01 SOL
    mythAmount = 21000.0;
  }
  
  const amountLamports = BigInt(Math.round(mythAmount * 1e9));
  const nonce = BigInt(adminNonce++);
  
  console.log(`[${i+1}/${pending.length}] ${recipient.toBase58().slice(0,8)}... ${solAmount} SOL → ${mythAmount} MYTH (nonce ${nonce})`);
  
  const nonceBuffer = Buffer.alloc(8);
  nonceBuffer.writeBigUInt64LE(nonce);
  const [processedPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('processed'), nonceBuffer], BRIDGE_L2
  );
  
  // OLD format: 113 bytes
  const data = Buffer.alloc(113);
  data.writeUInt8(2, 0);
  nonceBuffer.copy(data, 1);
  recipient.toBuffer().copy(data, 9);
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(amountLamports);
  amountBuf.copy(data, 41);
  const sig64 = Buffer.alloc(64, 0);
  sig64.write('pending_fix_' + nonce.toString(), 0);
  sig64.copy(data, 49);
  
  const ix = new TransactionInstruction({
    programId: BRIDGE_L2,
    keys: [
      { pubkey: sequencer.publicKey, isSigner: true, isWritable: false },
      { pubkey: sequencer.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPDA, isSigner: false, isWritable: true },
      { pubkey: reservePDA, isSigner: false, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: true },
      { pubkey: processedPDA, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  
  const computeIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 });
  
  try {
    const tx = new Transaction().add(computeIx, ix);
    const sig = await sendAndConfirmTransaction(conn, tx, [sequencer], { commitment: 'confirmed' });
    console.log(`  SUCCESS: ${sig}`);
    
    // Update DB to mark as completed
    db.prepare("UPDATE deposits SET status = 'completed', l2_tx_signature = ?, updated_at = datetime('now') WHERE id = ?")
      .run(sig, dep.id);
    console.log(`  DB updated: ${dep.id} → completed`);
    
    const bal = await conn.getBalance(recipient);
    console.log(`  Balance: ${bal / 1e9} MYTH`);
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
    if (e.logs) for (const l of e.logs.slice(-3)) console.error('    ' + l);
  }
}

console.log('\n=== Summary ===');
const remaining = db.prepare("SELECT COUNT(*) as cnt FROM deposits WHERE status != 'completed'").get();
console.log(`Remaining pending: ${remaining.cnt}`);
const reserveBal = await conn.getBalance(reservePDA);
console.log(`Reserve balance: ${reserveBal / 1e9} MYTH`);
db.close();
