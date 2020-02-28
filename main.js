#!/usr/bin/env node

const fs = require('fs');
const { pack } = require('./pack');

try {
    // check arguments
    if (process.argv.length < 7) {
        console.log(`Usage: ${process.argv[0]} ${process.argv[1]} <2.7|3.5> <output-path> <product-name> <module-name> <library-path> [...]`);
        process.exit(1);
    }

    // extract arguments
    const dialect = process.argv[2];
    const outputPath = process.argv[3];
    const productName = process.argv[4];
    const moduleName = process.argv[5];
    const libraryPaths = process.argv.slice(6);

    // pack
    const packed = pack(dialect, productName, moduleName, libraryPaths);
    fs.writeFileSync(outputPath, packed, { encoding: 'utf8' });
    process.exit(0);
}
catch (error) {
    console.error(`An error occured: ${error.message || error}`);
    process.exit(2);
}
