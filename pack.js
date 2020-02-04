const fs = require('fs');
const path = require('path');

function escape(script) {
    return script.split('\\').join('\\\\').split('\'').join('\\\'');
}

function findModule(moduleName, isMainModule, libraryPaths) {
    for (const libraryPath of libraryPaths) {
        // construct paths of reference module
        const modulePath = path.join(libraryPath, ...moduleName.split('.'));
        const packListPath = path.join(modulePath, 'pack.list');
        const mainScriptPath = path.join(modulePath, '__main__.py');
        // check if module exists
        if (fs.existsSync(packListPath) && (!isMainModule || fs.existsSync(mainScriptPath))) {
            return modulePath;
        }
    }
    return null;
}

function readPackList(refPackListPath) {
    return fs
        .readFileSync(refPackListPath, { encoding: 'utf8' })
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line);
}

function packEntries(dialect, modulePath, libName, packList, libraryPaths) {

    const result = new Map();

    for (const itemName of packList) {
        // handle library reference
        if (!itemName.startsWith('.')) {
            // pack library
            const refModulePath = findModule(itemName, false, libraryPaths);
            if (refModulePath) {
                const refPackList = readPackList(path.join(refModulePath, 'pack.list'));
                packEntries(dialect, refModulePath, itemName, refPackList, libraryPaths).forEach((v, k) => {
                    if (!result.has(k)) {
                        result.set(k, v);
                    } else {
                        if (result.get(k).spec !== v.spec || result.get(k).link !== v.link || result.get(k).loader !== v.loader) {
                            throw new Error(`two different scripts for ${k} detected`);
                        }
                    }
                });
            }
            // if we reach here, we could not find the reference module
            else {
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
                (libName.endsWith('.') ? libName.substr(0, libName.length - 1) : libName)
                + (itemName.endsWith('.') ? itemName.substr(0, itemName.length - 1) : itemName);
            const itemNameCode = JSON.stringify(itemNameQualified);

            // build package name
            const packageName = isPackage ? itemNameQualified : itemNameQualified.substring(0, itemNameQualified.lastIndexOf('.'));
            const packageNameCode = JSON.stringify(packageName);

            // build parent module name
            let parentModuleName = null;
            let parentModuleNameCode = null;

            let localModuleName = null;
            let localModuleNameCode = null;

            if (itemNameQualified.indexOf('.') !== -1) {
                const parts = itemNameQualified.split('.');
                localModuleName = parts.pop();
                localModuleNameCode = JSON.stringify(localModuleName);
                parentModuleName = parts.join('.');
                parentModuleNameCode = JSON.stringify(parentModuleName);
            }

            // pack
            let resultItem = null;

            let linkCode = '';
            if (parentModuleNameCode) {
                linkCode = `setattr(sys.modules[${parentModuleNameCode}], ${localModuleNameCode}, sys.modules[${itemNameCode}])`;
            }

            if (dialect == '2.7') {
                resultItem = {
                    spec:
                        `sys.modules[${itemNameCode}] = imp.new_module(${itemNameCode})\nsys.modules[${itemNameCode}].__name__ = ${itemNameCode}`
                        + `\nsys.modules[${itemNameCode}].__package__ = ${packageNameCode}`
                        + (isPackage ? `\nsys.modules[${itemNameCode}].__path__ = []` : ''),
                    link: linkCode,
                    loader: `exec '''${escape(fs.readFileSync(itemPath, { encoding: 'utf8' }))}''' in sys.modules[${itemNameCode}].__dict__`
                };
            } else if (dialect == '3.5') {
                resultItem = {
                    spec: `sys.modules[${itemNameCode}] = importlib.util.module_from_spec(importlib.util.spec_from_loader(${itemNameCode}, loader=None, is_package=${isPackage ? 'True' : 'None'}))`,
                    link: linkCode,
                    loader: `exec('''${escape(fs.readFileSync(itemPath, { encoding: 'utf8' }))}''', sys.modules[${itemNameCode}].__dict__)`
                };
            } else {
                throw new Error('unknown dialect');
            }

            result.set(itemNameQualified, resultItem);
        }
    }

    return result;
}

module.exports.pack = function pack(dialect, moduleName, libraryPaths) {

    // read module file and pack list
    const modulePath = findModule(moduleName, true, libraryPaths)
    const mainScript = fs.readFileSync(path.join(modulePath, '__main__.py'), { encoding: 'utf8' }).split(/\r?\n/);
    const packList = readPackList(path.join(modulePath, 'pack.list'));

    const packedEntries = packEntries(dialect, modulePath, moduleName, packList, libraryPaths)

    // find first import line
    let insertIdx = mainScript.findIndex(line => line.match(/(^|\s+)import(\s+|$)/));
    if (insertIdx === -1) {
        insertIdx = mainScript.length;
    }

    // insert packed entries and assemble result
    let importHeader = null;
    if (dialect == '2.7') {
        importHeader = 'import sys, imp';
    } else if (dialect == '3.5') {
        importHeader = 'import sys, importlib.util';
    } else {
        throw new Error('unknown dialect');
    }

    mainScript.splice(
        insertIdx, 0,
        `\n${importHeader}\n\n`
        + [...packedEntries.values()].map(entry => entry.spec).join('\n') + `\n\n`
        + [...packedEntries.values()].map(entry => entry.link).join('\n') + `\n\n`
        + [...packedEntries.values()].map(entry => entry.loader).join('\n\n') + `\n`
    );
    return mainScript.join('\n');
}
