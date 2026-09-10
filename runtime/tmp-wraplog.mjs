const fs = await import('node:fs');
const old=globalThis.fetch; let n=0;
globalThis.fetch=async (...a)=>{const [u,o]=a; n++; fs.appendFileSync('C:/Temp/hmcodex-fetch.log',`REQ ${n} ${o?.body}\n`); const res=await old(...a); return res;};
await import('./src/index.mjs');