const fs = require('fs');
const path = require('path');

function escape(script) {
    return script.split('\\').join('\\\\').split('\'').join('\\\'');
}

function readPackList(refPackListPath) {
    return fs
        .readFileSync(refPackListPath, { encoding: 'utf8' })
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line);
}

function packEntries(modulePath, moduleName, packList, libraryPaths) {

    const result = new Map();

    for (const itemName of packList) {
        // handle library reference
        if (!itemName.startsWith('.')) {
            // search in library paths
            let found = false;
            for (const libraryPath of libraryPaths) {
                // construct paths of reference module
                const refModulePath = path.join(libraryPath, ...itemName.split('.'));
                const refPackListPath = path.join(refModulePath, 'pack.list');
                // if pack list exists, pack module entries
                if (fs.existsSync(refPackListPath)) {
                    const refPackList = readPackList(refPackListPath);
                    packEntries(refModulePath, itemName, refPackList, libraryPaths).forEach((v, k) => {
                        if (!result.has(k)) {
                            result.set(k, v);
                        } else {
                            if (result.get(k).spec !== v.spec || result.get(k).loader !== v.loader) {
                                throw new Error(`two different scripts for ${k} detected`);
                            }
                        }
                    });
                    found = true;
                    break;
                }
            }
            // if we reach here, we could not find the reference module
            if (!found) {
                throw new Error(`could not find ${itemName} in library paths (pack.list available?)`);
            }
        }
        // handle local file reference
        else {
            // lookup item path
            const itemPathBase = path.join(modulePath, ...itemName.substr(1).split('.'));
            const itemPaths = [itemPathBase + '.py', path.join(itemPathBase, '__init__.py')];
            const itemPath = itemPaths.filter(itemPath => fs.existsSync(itemPath)).pop();

            if (!itemPath) {
                throw new Error(`could not find ${itemName} in module`);
            }

            const isPackage = itemPath == itemPaths[1];

            // build qualified name
            const itemNameQualified =
                (moduleName.endsWith('.') ? moduleName.substr(0, moduleName.length - 1) : moduleName)
                + (itemName.endsWith('.') ? itemName.substr(0, itemName.length - 1) : itemName);
            const itemNameCode = (itemNameQualified.startsWith('.') ? '__name__ + ' : '') + JSON.stringify(itemNameQualified);

            // pack
            result.set(
                itemNameQualified,
                {
                    spec: `sys.modules[${itemNameCode}] = importlib.util.module_from_spec(importlib.util.spec_from_loader(${itemNameCode}, loader=None, is_package=${isPackage ? 'True' : 'None'}))`,
                    loader: `exec('''${escape(fs.readFileSync(itemPath, { encoding: 'utf8' }))}''', sys.modules[${itemNameCode}].__dict__)`
                }
            )
        }
    }

    return result;
}

module.exports.pack = function pack(modulePath, libraryPaths) {

    // read module file and pack list
    const moduleInitFile = fs.readFileSync(path.join(modulePath, '__init__.py'), { encoding: 'utf8' }).split(/\r?\n/);
    const packList = readPackList(path.join(modulePath, 'pack.list'));

    if (packList.pop() != '.') {
        throw new Error('last entry of initial pack list should be "."');
    }

    const packedEntries = packEntries(modulePath, '.', packList, libraryPaths)

    // find first import line
    let insertIdx = moduleInitFile.findIndex(line => line.match(/(^|\s+)import(\s+|$)/));
    if (insertIdx === -1) {
        insertIdx = moduleInitFile.length;
    }

    // insert packed entries and assemble result
    moduleInitFile.splice(
        insertIdx, 0,
        `\n\nimport sys, importlib.util\n\n`
        + [...packedEntries.values()].map(entry => entry.spec).join('\n\n')
        + `\n\n`
        + [...packedEntries.values()].map(entry => entry.loader).join('\n\n')
    );
    return moduleInitFile.join('\n');
}
