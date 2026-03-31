#!/usr/bin/env node
// Injects AudioWorkletGlobalScope polyfills into the wasm-pack generated JS.
// Run after every wasm-pack build: node patch-wasm.js
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '../web/wasm/clankers_dsp.js');
let src = fs.readFileSync(file, 'utf8');

const MARKER = 'let cachedTextDecoder =';
if (src.includes('AudioWorkletGlobalScope polyfills')) {
  console.log('patch-wasm: polyfills already present, skipping.');
  process.exit(0);
}
if (!src.includes(MARKER)) {
  console.error('patch-wasm: marker not found — wasm-pack output format may have changed.');
  process.exit(1);
}

const POLYFILL = `// ── AudioWorkletGlobalScope polyfills ─────────────────────────────────────────
if (typeof TextDecoder === 'undefined') {
    globalThis.TextDecoder = class TextDecoder {
        constructor(_e, _o) {}
        decode(buf) {
            if (!buf || buf.byteLength === 0) return '';
            const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer ?? buf);
            let s = '', i = 0;
            while (i < b.length) {
                const c = b[i++];
                if (c < 0x80) { s += String.fromCharCode(c); }
                else if ((c & 0xE0) === 0xC0) { s += String.fromCharCode(((c&0x1F)<<6)|(b[i++]&0x3F)); }
                else if ((c & 0xF0) === 0xE0) { s += String.fromCharCode(((c&0x0F)<<12)|((b[i++]&0x3F)<<6)|(b[i++]&0x3F)); }
                else { const p=((c&7)<<18)|((b[i++]&0x3F)<<12)|((b[i++]&0x3F)<<6)|(b[i++]&0x3F); const u=p-0x10000; s+=String.fromCharCode(0xD800+(u>>10),0xDC00+(u&0x3FF)); }
            }
            return s;
        }
    };
}
if (typeof TextEncoder === 'undefined') {
    globalThis.TextEncoder = class TextEncoder {
        encode(s) {
            const o=[];
            for (let i=0;i<s.length;i++) {
                let c=s.charCodeAt(i);
                if(c>=0xD800&&c<=0xDBFF) c=0x10000+((c-0xD800)<<10)+(s.charCodeAt(++i)-0xDC00);
                if(c<0x80) o.push(c);
                else if(c<0x800) o.push(0xC0|(c>>6),0x80|(c&0x3F));
                else if(c<0x10000) o.push(0xE0|(c>>12),0x80|((c>>6)&0x3F),0x80|(c&0x3F));
                else o.push(0xF0|(c>>18),0x80|((c>>12)&0x3F),0x80|((c>>6)&0x3F),0x80|(c&0x3F));
            }
            return new Uint8Array(o);
        }
        encodeInto(s,v){const b=this.encode(s);v.set(b);return{read:s.length,written:b.length};}
    };
}

`;

src = src.replace(MARKER, POLYFILL + MARKER);
fs.writeFileSync(file, src, 'utf8');
console.log('patch-wasm: polyfills injected successfully.');
