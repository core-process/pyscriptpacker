const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function findLibrary(libraryName, isMainLibrary, libraryPaths) {

    if (libraryName.match(/[^\w]/)) {
        throw new Error('invalid library name');
    }

    for (const libraryBasePath of libraryPaths) {
        // construct library path
        const libraryPath = path.join(libraryBasePath, libraryName);
        // check if library exists
        if (
            fs.existsSync(path.join(libraryPath, 'pack.list'))
            && (!isMainLibrary || fs.existsSync(path.join(libraryPath, '__main__.py')))
        ) {
            return libraryPath;
        }
    }

    throw new Error(`could not find ${packEntry} in library paths (pack.list available?)`);
}

function readPackList(libraryPath) {
    return fs
        .readFileSync(path.join(libraryPath, 'pack.list'), { encoding: 'utf8' })
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line);
}

function packModules(dialect, productName, libraryPath, libraryName, libraryPaths) {

    // read pack list
    const packList = readPackList(libraryPath);

    // add product base module
    const modules = new Map();

    {
        const productNameCode = JSON.stringify(productName);
        let moduleSpec = null;

        if (dialect == '2.7') {
            moduleSpec = {
                alloc:
                    `sys.modules[${productNameCode}] = imp.new_module(${productNameCode})`
                    + `\nsys.modules[${productNameCode}].__name__ = ${productNameCode}`
                    + `\nsys.modules[${productNameCode}].__package__ = ${JSON.stringify(productNameCode)}`
                    + `\nsys.modules[${productNameCode}].__path__ = []`,
                link: '',
                load: ''
            };
        } else {
            moduleSpec = {
                alloc: `sys.modules[${productNameCode}] = importlib.util.module_from_spec(importlib.util.spec_from_loader(${productNameCode}, loader=None, is_package='True'))`,
                link: '',
                load: ''
            };
        }

        modules.set(productName, moduleSpec);
    }

    // pack modules
    for (const packEntry of packList) {

        // handle library reference
        if (!packEntry.startsWith('.')) {
            // pack library
            packModules(dialect, productName, findLibrary(packEntry, false, libraryPaths), packEntry, libraryPaths).forEach((moduleSpec, moduleName) => {
                if (!modules.has(moduleName)) {
                    modules.set(moduleName, moduleSpec);
                } else {
                    if (modules.get(moduleName).alloc !== moduleSpec.alloc
                        || modules.get(moduleName).link !== moduleSpec.link
                        || modules.get(moduleName).load !== moduleSpec.load
                    ) {
                        throw new Error(`two different scripts for ${moduleName} detected`);
                    }
                }
            });
        }
        // handle local file reference
        else {
            // lookup item path
            const moduleBasePath = path.join(libraryPath, ...packEntry.substr(1).split('.'));
            const modulePaths = [moduleBasePath + '.py', path.join(moduleBasePath, '__init__.py')];
            const modulePath = modulePaths.filter(modulePath => fs.existsSync(modulePath)).pop();

            if (!modulePath) {
                throw new Error(`could not find ${packEntry} in ${libraryName}`);
            }

            // determine if module is a package
            const isPackage = modulePath == modulePaths[1];

            // build module name
            const moduleName =
                productName + '.'
                + (libraryName.endsWith('.') ? libraryName.substr(0, libraryName.length - 1) : libraryName)
                + (packEntry.endsWith('.') ? packEntry.substr(0, packEntry.length - 1) : packEntry);
            const moduleNameCode = JSON.stringify(moduleName);

            // build parent module name
            const moduleLocalName = moduleName.split('.').pop();
            const moduleParentName = moduleName.substr(0, moduleName.length - moduleLocalName.length - 1);

            // build package name
            const packageName = isPackage ? moduleName : moduleName.substring(0, moduleName.lastIndexOf('.'));

            // rewrite library imports
            let moduleScript = fs.readFileSync(modulePath, { encoding: 'utf8' }).split(/\r?\n/);

            moduleScript = moduleScript.map(line => {
                const m = line.match(/^(\s*import\s+)(\w+)\s*$/);
                if (m && packList.includes(m[2])) {
                    return m[1] + productName + '.' + m[2] + ' as ' + m[2];
                }
                return line;
            });

            moduleScript = `'''${moduleScript.join('\n').split('\\').join('\\\\').split('\'').join('\\\'')}'''`;

            // pack
            let moduleSpec = null;

            const linkCode = `setattr(sys.modules[${JSON.stringify(moduleParentName)}], ${JSON.stringify(moduleLocalName)}, sys.modules[${moduleNameCode}])`;

            if (dialect == '2.7') {
                moduleSpec = {
                    alloc:
                        `sys.modules[${moduleNameCode}] = imp.new_module(${moduleNameCode})`
                        + `\nsys.modules[${moduleNameCode}].__name__ = ${moduleNameCode}`
                        + `\nsys.modules[${moduleNameCode}].__package__ = ${JSON.stringify(packageName)}`
                        + (isPackage ? `\nsys.modules[${moduleNameCode}].__path__ = []` : ''),
                    link: linkCode,
                    load: `exec ${moduleScript} in sys.modules[${moduleNameCode}].__dict__`
                };
            } else {
                moduleSpec = {
                    alloc: `sys.modules[${moduleNameCode}] = importlib.util.module_from_spec(importlib.util.spec_from_loader(${moduleNameCode}, loader=None, is_package=${isPackage ? 'True' : 'None'}))`,
                    link: linkCode,
                    load: `exec(${moduleScript}, sys.modules[${moduleNameCode}].__dict__)`
                };
            }

            modules.set(moduleName, moduleSpec);
        }
    }

    return modules;
}

module.exports.pack = function pack(dialect, productName, libraryName, libraryPaths) {

    // generate unique product name
    if (productName == '*') {
        productName = crypto.randomBytes(8).toString('hex');
    }

    // validate args
    if (dialect != '2.7' && dialect != '3.5') {
        throw new Error('unknown dialect');
    }

    if (productName.match(/[^\w]/)) {
        throw new Error('invalid product name');
    }

    // ... libraryName will be validated by findLibrary

    // read main script
    const libraryPath = findLibrary(libraryName, true, libraryPaths)
    let mainScript = fs.readFileSync(path.join(libraryPath, '__main__.py'), { encoding: 'utf8' }).split(/\r?\n/);

    // rewrite library imports
    const packList = readPackList(libraryPath);
    mainScript = mainScript.map(line => {
        const m = line.match(/^(\s*import\s+)(\w+)\s*$/);
        if (m && (m[2] == libraryName || packList.includes(m[2]))) {
            return m[1] + productName + '.' + m[2] + ' as ' + m[2];
        }
        return line;
    });

    // pack modules
    const modules = packModules(dialect, productName, libraryPath, libraryName, libraryPaths)

    // insert packed modules
    let importCode = null;
    if (dialect == '2.7') {
        importCode = 'import sys, imp';
    } else {
        importCode = 'import sys, importlib.util';
    }

    const packLine = mainScript.findIndex(line => line.match(/^\s*#\s+!!!\s+PACK\s+HERE\s+!!!\s*$/i));

    mainScript.splice(
        packLine !== -1 ? packLine : 0,
        packLine !== -1 ? 1 : 0,
        `\n${importCode}\n\n`
        + [...modules.values()].map(moduleSpec => moduleSpec.alloc).join('\n') + `\n\n`
        + [...modules.values()].map(moduleSpec => moduleSpec.link).join('\n') + `\n\n`
        + [...modules.values()].map(moduleSpec => moduleSpec.load).join('\n\n') + `\n`
    );

    // assemble result
    return mainScript.join('\n');
}
