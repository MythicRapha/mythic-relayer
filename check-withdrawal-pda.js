const { Connection, PublicKey } = require("@solana/web3.js");

(async () => {
  const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
  const bridge = new PublicKey("oEQfREm4FQkaVeRoxJHkJLB1feHprrntY6eJuW2zbqQ");

  for (const nonce of [31, 32]) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(nonce));
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("withdrawal"), buf], bridge);
    const acct = await conn.getAccountInfo(pda);
    if (acct === null) { console.log("Nonce", nonce, "- NOT FOUND"); continue; }
    const d = acct.data;
    const recipient = new PublicKey(d.slice(0, 32)).toBase58();
    const amount = Number(d.readBigUInt64LE(32));
    const deadline = Number(d.readBigInt64LE(104));
    const status = d[112];
    const now = Math.floor(Date.now() / 1000);
    console.log("Nonce", nonce, "| PDA:", pda.toBase58());
    console.log("  recipient:", recipient);
    console.log("  amount:", (amount / 1e6).toFixed(2), "MYTH");
    console.log("  deadline:", new Date(deadline * 1000).toISOString());
    console.log("  status:", status, "(0=Pending, 2=Finalized)");
    console.log("  remaining:", ((deadline - now) / 60).toFixed(0), "min");
  }
})();
