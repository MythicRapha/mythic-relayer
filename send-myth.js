const { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } = require("@solana/web3.js");
const { getOrCreateAssociatedTokenAccount, createTransferInstruction, getAssociatedTokenAddress } = require("@solana/spl-token");
const fs = require("fs");

(async () => {
  const conn = new Connection("http://127.0.0.1:8899", "confirmed");
  const sender = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("/mnt/data/mythic-l2/keys/deployer.json", "utf-8"))));
  const MYTH_MINT = new PublicKey("7sfazeMxmuoDkuU5fHkDGin8uYuaTkZrRSwJM1CHXvDq");
  const recipient = new PublicKey("6SrpJsrLHFAs6iPHFRNYmtEHUVnXyd1Q3iSqcVp8myth");
  const amount = 10_000_000 * 1_000_000; // 10M MYTH, 6 decimals

  // Get sender ATA
  const senderATA = await getAssociatedTokenAddress(MYTH_MINT, sender.publicKey);
  const senderBal = await conn.getTokenAccountBalance(senderATA);
  console.log("Sender MYTH balance:", senderBal.value.uiAmountString);

  // Get or create recipient ATA
  const recipientATA = await getOrCreateAssociatedTokenAccount(conn, sender, MYTH_MINT, recipient);
  console.log("Recipient ATA:", recipientATA.address.toBase58());

  // Transfer
  const ix = createTransferInstruction(senderATA, recipientATA.address, sender.publicKey, amount);
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(conn, tx, [sender]);
  console.log("Sent 10,000,000 MYTH to", recipient.toBase58());
  console.log("Tx:", sig);

  // Verify
  const newBal = await conn.getTokenAccountBalance(recipientATA.address);
  console.log("Recipient new balance:", newBal.value.uiAmountString, "MYTH");
})();
