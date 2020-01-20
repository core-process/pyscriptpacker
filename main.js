#!/usr/bin/env node

const fs = require('fs');
const { pack } = require('./pack');

if (process.argv.length != 4) {
    console.log(`Usage: ${process.argv[0]} ${process.argv[1]} input.py output.py`);
    process.exit(1);
}

try {
    const packed = pack(process.argv[2]);
    fs.writeFileSync(process.argv[3], packed, { encoding: 'utf8' });
    process.exit(0);
}
catch (error) {
    console.error(`An error occured: ${error.message || error}`);
    process.exit(2);
}
