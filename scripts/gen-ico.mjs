import pngToIco from 'png-to-ico';
import fs from 'fs';

const buf = await pngToIco('build/icon.png');
fs.writeFileSync('build/icon.ico', buf);
console.log('ICO created:', buf.length, 'bytes');
