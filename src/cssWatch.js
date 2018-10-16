#!/usr/bin/env node

var path = require('path')
var fse = require('fs-extra')
var watchman = require('fb-watchman');
var client = new watchman.Client();

const utils = require('./util')
const createStylefromCode = utils.createStylefromCode
const convertStylesToRNCSS = utils.convertStylesToRNCSS
var dir_of_interest = process.cwd()
var resMap = new Map()
client.capabilityCheck({optional: [], required: ['relative_root']},
    function (error, resp) {
        if (error) {
            console.log(error);
            client.end();
            return;
        }

        // Initiate the watch
        client.command(['watch-project', dir_of_interest],
            function (error, resp) {
                if (error) {
                    console.error('Error initiating watch:', error);
                    return;
                }
                if ('warning' in resp) {
                    console.log('warning: ', resp.warning);
                }


                console.log('watch established on ', resp.watch,
                    ' relative_path', resp.relative_path);


                make_subscription(client, resp.watch, resp.relative_path)
            });
    });
var testFirstLoadMap = new Map()

function make_subscription(client, watch, relative_path) {
    var sub = {
        // Match any `.js` file in the dir_of_interest
        expression: ["allof", ["match", "*.css"], ["not", ["dirname", "node_modules"]]],
        // Which fields we're interested in
        fields: ["name", "size", "mtime_ms", "exists", "type"]
    };
    if (relative_path) {
        sub.relative_root = relative_path;
    }

    client.command(['subscribe', watch, 'mysubscription', sub],
        function (error, resp) {
            if (error) {
                // Probably an error in the subscription criteria
                console.error('failed to subscribe: ', error);
                return;
            }
            console.log('subscription ' + resp.subscribe + ' established');
        });
    client.on('subscription', function (resp) {
        if (resp.subscription !== 'mysubscription') return;

        /**
         * watch all css file, when changed, generate new styleMap
         */
        resp.files.forEach(function (file) {

            const absPath = path.resolve(file.name)

            const cssStr = fse.readFileSync(absPath).toString()

            const {styles: obj, imports: arr} = createStylefromCode(cssStr, absPath)
            const lastPath = path.dirname(absPath)
            const newArr = arr.map(e => {
                return path.resolve(lastPath, e)
            })
            newArr.forEach(e => {
                if (!resMap.has(e) && e !== absPath) {
                    resMap.set(e, new Set())
                }
                resMap.get(e).add(absPath)
            })
            const cssObj = convertStylesToRNCSS(obj)
            const newPath = mkPath(absPath)
            const newDic = path.dirname(newPath)
            fse.mkdirsSync(newDic)
            fse.writeFileSync(newPath, `export default styles = ${cssObj}`)
            if (!testFirstLoadMap.has(absPath)) {
                testFirstLoadMap.set(absPath, false)
            } else {
                testFirstLoadMap.set(absPath, true)
            }

            /**
             * Modify related css files recursively
             */
            if (testFirstLoadMap.get(absPath)) {
                recallInMap(resMap, absPath)
            }
        });
    });
}

/**
 * generate related js files in /node_modules/@xxx/babel-plugin-import-css/rncsscache
 * @param absPath
 * @returns {*}
 */
function mkPath(absPath) {
    let localPrefix = absPath.substring(absPath.indexOf(dir_of_interest) + dir_of_interest.length)
    if (localPrefix.startsWith("/")) localPrefix = localPrefix.substring(1)
    return path.resolve(dir_of_interest,
        'node_modules',
        '@areslabs',
        'babel-plugin-import-css',
        'rncsscache',
        localPrefix + '.js'
    )
}

function forceUpdate(keyPath) {
    const cssStr = fse.readFileSync(keyPath).toString()
    const {styles: obj} = createStylefromCode(cssStr, keyPath)
    let cssObj = convertStylesToRNCSS(obj)
    const newPath = mkPath(keyPath)
    const newDic = path.dirname(newPath)
    fse.mkdirsSync(newDic)
    fse.writeFileSync(newPath, `export default styles = ${cssObj}`)
}

/**
 * Modify related css files recursively
 * @param resMap
 * @param absPath
 */
function recallInMap(resMap, absPath) {
    if (resMap.has(absPath) && resMap.get(absPath).size > 0) {
        for (let keyPath of resMap.get(absPath)) {
            //update first
            forceUpdate(keyPath)
            recallInMap(resMap, keyPath)
        }
    }
}
