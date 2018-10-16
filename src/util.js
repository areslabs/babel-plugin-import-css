const fs = require('fs')
const transform = require('css-to-react-native').default
var csstree = require('css-tree')
var path = require('path')

/**
 * get import content in css file,may import multi times
 * @param styles css file content
 * @returns {Array} result
 */
function queryImport(styles) {
    if (styles.indexOf('@import') < 0) return []
    const arr = []
    const ast = csstree.parse(styles);
    csstree.walk(ast, {
        enter: function (node) {
            if (node.type === 'Atrule' && node.name === 'import') {
                const pat = node.prelude.children.head.data.value
                arr.push(pat.substring(1, pat.length - 1))
            }
        }
    })
    return arr
}

/**
 * handle with import procedure,may search involved file in project
 * @param styles styles css file content
 * @param initPath project path, used for searching target file
 * @param mayRM this param avoid loop importing
 * @returns handled styles content
 */
function handleImportStyle(styles, initPath, mayRM) {
    if (!!mayRM) {
        styles = styles.replace(mayRM, '')
    }
    if (styles.indexOf('@import') < 0) return styles
    const ast = csstree.parse(styles);
    csstree.walk(ast, {
        enter: function (node) {
            if (node.type === 'Atrule') {
                if (node.name === 'import') {
                    const pat = node.prelude.children.head.data.value
                    if (initPath && typeof pat === 'string') {
                        const realP = pat.substring(1, pat.length - 1)
                        const newPath = path.dirname(initPath)
                        const resPath = path.resolve(newPath, realP)
                        const text = fs.readFileSync(resPath).toString()
                        const re = new RegExp("[\\s]*@import[\\s]+\"" + realP + "\";", "g");
                        //handle with loop import
                        styles = styles.replace(re, handleImportStyle(text, resPath, re))
                    }
                }
            }
        }
    })
    return styles
}

/**
 * create style object from css file content,which is raw string.
 * @param styles styles styles css file content
 * @param abspath project file path
 * @returns {{styles, imports: Array}}
 */
function createStylefromCode(styles, abspath) {
    //may import other file
    const arr = queryImport(styles)
    const baseRes = handleImportStyle(styles, abspath)
    const obj = {}
    const ast = csstree.parse(baseRes);
    csstree.walk(ast, {
        enter: function (node) {
            if (node.type === 'Rule' && node.prelude && node.prelude.type === 'SelectorList') {
                const clzName = []
                node.prelude.children.forEach(e => {
                    //we may handle each class selector here
                    let ans = selectorBlockHandler(e)
                    if (ans) {
                        //to save before value
                        obj[ans] = obj[ans] || {}
                        //save ans to log which to give value
                        clzName.push(ans)
                    }
                })
                const styleArray = []
                node.block.children.forEach(e => {
                    //handle with unit or function case
                    const styleItem = styleBlockHandler(e)
                    styleItem.length > 0 && styleArray.push(styleItem)
                })
                clzName.forEach(e => {
                    try {
                        const styleObject = transform(styleArray)
                        if (styleObject.fontWeight) {
                            //fontWeight must be string
                            styleObject.fontWeight = styleObject.fontWeight + ""
                        }
                        Object.assign(obj[e], styleObject)
                    } catch (e) {
                        console.error("convert ", abspath, " error:", e.message)
                    }

                })
            }
        },
    })
    return {styles: obj, imports: arr}
}

/**
 * create special style dict structure for high performance query
 * @param styles style object
 */
function createStyleDictionary(styles) {
    let total = {}
    for (let k in styles) {
        const val = styles[k]
        //sort clz name to judge arbitrary order in multi-className
        k = sortSeq(k)
        //merge style chain from last condition
        const lastEle = getLastEle(k)
        //no sharing data. create new chain
        if (!total.hasOwnProperty(lastEle)) {
            total[lastEle] = createItem(k, val)[lastEle]
        } else {
            //merge chain data
            merge(createItem(k, styles[k]), total)
        }
    }
    return total
}

/**
 * count specific character in target string
 * @param str target string
 * @param ch specific character
 * @returns number of character in string
 */
function countCharFromStr(str, ch) {
    let strArr = [...str];
    let count = 0;
    for (let k in strArr) {
        if (strArr[k] === ch) {
            count++
        }
    }
    return count
}

/**
 * sort string split by '.',i.e. '.b.c.a'->'.a.b.c'
 * @param str input string, i.e. '.b.c.a'
 * @returns {string}
 */
const sortSeq = (str) => {
    //may got descendant className case
    return str.split(" ").filter(e => !!e && e.trim().length > 0).map(e => {
        if (countCharFromStr(e, '.') > 1) {
            return '.' + e.split(".").filter(e => !!e && e.trim().length > 0).sort().join(".")
        } else return e
    }).join(" ")
}

/**
 * create base styleItem,we say,as {".a":{'_#_':color:'red',fontSize:12}}. take '_#_' as end searching flag.
 * @param name
 * @param val
 */
const createItem = (name, val) => {
    let nameArr = name.split(" ").filter(e => !!e && e.trim().length > 0).reverse()
    const map = {}
    let refMap = map
    let len = nameArr.length
    //traverse map reference,refMap change in every procedure
    for (let ind in nameArr) {
        if (ind < len) {
            refMap[nameArr[ind]] = {}
            refMap = refMap[nameArr[ind]]
        }
    }
    //end flag
    refMap["_#_"] = val
    return map
}

/**
 * merge single chain data into main chain
 * @param linka single chain
 * @param linkb main chain
 * @return main chain merged
 */
const merge = (linka, linkb) => {
    let refa = linka
    let refb = linkb
    while (Object.keys(refa).length) {
        for (let key in refa) {
            //if refb and refa has same key,continue traversing,or merge style content when meeting end flag
            if (refb.hasOwnProperty(key)) {
                if (key === '_#_') {
                    refb[key] = Object.assign({}, refa[key], refb[key])
                    return linkb
                }
                refa = refa[key]
                refb = refb[key]
                break
            } else {
                //merge and return
                refb[key] = refa[key]
                return linkb
            }
        }
    }
}

/**
 * get last element in string splited by space
 * @param str input string
 * @return {string | undefined}
 */
const getLastEle = (str) => {
    return str.split(" ").filter(e => e.length > 0).pop()
}

/**
 * get input css file content,and generate style object
 * @param styles css file content
 * @return {string} serialized css object
 */
function convertStylesToRNCSS(styles) {
    const cssMap = createStyleDictionary(styles)
    return JSON.stringify(cssMap)
}

/**
 * handle with selector part in node's structure
 * @param element node to be searched
 * @return {*}
 */
function selectorBlockHandler(element) {
    if (element.type === 'Selector') {
        const name = []
        let discard = false
        element.children.forEach(e => {
            switch (e.type) {
                case "ClassSelector":
                    name.push("." + e.name);
                    break;
                    //not support for now
                case "Combinator":
                    name.push(e.name);
                    discard = true
                    return null
                case "TypeSelector":
                    name.push(e.name);
                    break;
                case "IdSelector":
                    //not support for now
                    name.push("#" + e.name);
                    discard = true
                    return null
                case "WhiteSpace":
                    name.push(" ");
                    break
                default: {
                    // console.warn('unknown selector type:', e)
                    discard = true
                    return null
                }
            }
        })
        if (!discard)
            return name.join("")
        else return null
    }
}

/**
 * do some padding modification,to produce more stable run-time environment
 * @param proper
 * @param arr
 * @return {*}
 */
function paddingElementForTransform(proper, arr) {
    //RN not support multi font-family keywords
    if (proper === 'font-family') {
        return [proper, arr.pop()]
    }
    //not support such shorthand
    if (proper === 'background') {
        return ['background-color', arr.join(" ")]
    }
    //not support such shorthand
    if (proper === 'border-bottom' || proper === 'border-top' || proper === 'border-right' || proper === 'border-left') {
        // console.warn("not support property",proper)
        return []
    }
    //content property should take just single value
    if (proper === 'content' && arr.length === 1)
        return [proper, arr[0]]
    return [proper, arr.join(" ")]
}

/**
 * let transform given unit
 * @param item input unit
 * @return {*|string}
 */
function queryUnit(item) {
    return item || ""
}

/**
 * handle with different node structure in ast
 * @param element
 * @return {*}
 */
function styleBlockHandler(element) {
    const {property, value} = element
    let result = []
    const styleContent = value && value.children ? value.children : []
    const defaultUnit = "px"
    styleContent.forEach(e => {
        switch (e.type) {
            case "Identifier":
                result.push(e.name);
                break
            case "Dimension":
                result.push(e.value + defaultUnit);
                break
            case 'Function': {
                //function case need '()' container,such as rgb(255,0,0)
                let name = e.name + "("
                e.children.forEach(e => name += e.value + queryUnit(e.unit))
                result.push(name + ")")
                break
            }
            case "HexColor": {
                result.push("#" + e.value)
                break
            }
            case "String": {
                const str = e.value
                result.push(str)
                break
            }
            case "Number": {
                result.push(e.value)
                break
            }
            case "Percentage": {
                result.push(e.value + "%")
                break
            }
            case "WhiteSpace": {
                break
            }
            case "Operator": {
                break
            }
            case "Url": {
                break
            }
            default:
                // console.log("unknown,", property, e)
                break
        }
    })
    //padding modification
    if (result.length > 0)
        return paddingElementForTransform(property, result)
    return []
}

module.exports = {
    createStylefromCode: createStylefromCode,
    convertStylesToRNCSS: convertStylesToRNCSS
}