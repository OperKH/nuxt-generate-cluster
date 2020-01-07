'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

function _interopNamespace(e) {
  if (e && e.__esModule) { return e; } else {
    var n = {};
    if (e) {
      Object.keys(e).forEach(function (k) {
        var d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: function () {
            return e[k];
          }
        });
      });
    }
    n['default'] = e;
    return n;
  }
}

const cluster = require('cluster');
const cluster__default = _interopDefault(cluster);
const env = _interopDefault(require('std-env'));
const figures = _interopDefault(require('figures'));
const chalk = _interopDefault(require('chalk'));
const uuid = _interopDefault(require('uuid'));
const consola$2 = _interopDefault(require('consola'));
const path = _interopDefault(require('path'));

const Commands = {
  sendErrors: 'handleErrors',
  sendRoutes: 'requestRoutes',
  logSuccess: 'logSuccess',
  logError: 'logError'
};

class MessageBroker {
  constructor({ isMaster, masterId, alias, autoListen } = {}, masterRef) {
    this.id = uuid();

    this.isMaster = isMaster !== undefined ? isMaster : cluster__default.isMaster;
    this.masterId = masterId || 'master';
    this.masterRef = masterRef;

    this.alias = alias || (this.isMaster ? this.masterId : undefined);
    this.listening = false;

    this.proxies = {};
    this.services = {};

    // this._messageHandler
    if (autoListen !== false) {
      this.listen();
    }
  }

  registerWithMaster() {
    this.send(this.masterId, '_register', {
      alias: this.alias
    });
  }

  registerProxy({ alias }, senderId, ref) {
    consola$2.debug(`registering ${senderId} ` + (alias ? `with alias ${alias}` : 'without alias') + (ref && ref.id ? ` and id ${ref.id}` : ''));

    this.proxies[senderId] = ref;

    if (alias) {
      this.proxies[alias] = ref;
    }
  }

  listen() {
    if (!this.isMaster) {
      this.registerWithMaster();
    } else {
      this.on('_register', (...args) => {
        this.registerProxy(...args);
      });
    }

    if (!this.listening) {
      if (this.isMaster) {
        this._messageHandler = (worker, message) => {
          /* istanbul ignore next */
          this.handleMessage(message, worker);
        };

        cluster__default.on('message', this._messageHandler);
      } else {
        this._messageHandler = (message) => {
          /* istanbul ignore next */
          this.handleMessage(message);
        };

        process.on('message', this._messageHandler);
      }

      this.listening = true;
    }
  }

  close() {
    if (this._messageHandler) {
      if (this.isMaster) {
        cluster__default.removeListener('message', this._messageHandler);
      } else {
        process.removeListener('message', this._messageHandler);
      }
    }
  }

  handleMessage(message, worker) {
    consola$2.trace((this.alias || this.id) + ' received message', message instanceof Object ? JSON.stringify(message) : message);

    const { receiverId } = message;
    if (receiverId !== undefined) {
      if (
        receiverId === this.id ||
        receiverId === this.alias ||
        (this.isMaster && receiverId === this.masterId)
      ) {
        this.callService(message, worker);
      } else if (this.isMaster && this.proxies[receiverId]) {
        this.proxies[receiverId].send(message);
      } else {
        consola$2.warn(`Proxy ${receiverId} not registered`);
      }
    }
  }

  callService({ senderId, serviceId, data }, worker) {
    if (serviceId in this.services) {
      this.services[serviceId](data, senderId, worker);
    } else {
      consola$2.warn(`Proxy '${this.alias || this.id}': Service ${serviceId} not registered`);
    }
  }

  on(serviceId, callback, overwrite) {
    if (serviceId in this.services && !overwrite) {
      consola$2.warn(`Service ${serviceId} already registered`);
    } else {
      this.services[serviceId] = callback;
    }
  }

  send(receiverIdOrAlias, serviceId, data) {
    const message = {
      receiverId: receiverIdOrAlias || this.masterId,
      senderId: this.id,
      serviceId,
      data
    };
    this.sendMessage(message);
  }

  sendMessage(message) {
    if (!this.isMaster && !cluster__default.isMaster) {
      consola$2.trace(`sending message through process`, JSON.stringify(message));

      process.send(message);
    } else if (!this.isMaster && this.masterRef) {
      return new Promise((resolve) => {
        consola$2.trace(`sending message through promise`, JSON.stringify(message));

        const ref = {};
        if (message.serviceId === '_register') {
          ref.send = (message) => {
            this.handleMessage(message);
          };
        }

        this.masterRef.handleMessage(message, ref);
        resolve();
      })
    } else if (this.proxies[message.receiverId]) {
      consola$2.trace(`sending message through proxy`, JSON.stringify(message));

      this.proxies[message.receiverId].send(message);
    } else if (message.receiverId === this.id || message.receiverId === this.alias) {
      this.handleMessage(message);
    } else {
      consola$2.error(`Unable to send message, unknown receiver ${message.receiverId}`);
    }
  }
}

const messaging = new MessageBroker();

// Consola Reporter
class Reporter {
  log(logObj, { async } = {}) {
    if (logObj.type === 'success' && logObj.args[0].startsWith('Generated ')) {
      // Ignore success messages from Nuxt.Generator::generateRoute
      return
    } else if (logObj.type === 'error' && logObj.args[0].startsWith('Error generating ')) {
      // Ignore error messages from Nuxt.Generator::generateRoute
      return
    }

    if (global._ngc_log_tag) {
      logObj.tag = global._ngc_log_tag;
    }

    messaging.send(null, 'consola', { logObj, stream: { async } });
  }
}

let _consola;
if (global.__consolaSet === undefined) {
  _consola = global.consola;
  // Delete the global.consola set by consola self
  delete global.consola;
}

let consola = global.consola; // eslint-disable-line import/no-mutable-exports

if (!consola) {
  consola = _consola.create({
    level: env.debug ? 5 : 3,
    types: {
      ..._consola._types,
      ...{
        cluster: {
          level: 4,
          color: 'blue',
          icon: chalk.magenta(figures.radioOn)
        },
        master: {
          level: 2,
          color: 'blue',
          icon: chalk.cyan(figures.info)
        },
        debug: {
          level: 5,
          color: 'grey'
        },
        trace: {
          level: 6,
          color: 'white'
        }
      }
    }
  });
  _consola = null;

  if (cluster.isMaster) {
    /* istanbul ignore next */
    messaging.on('consola', ({ logObj, stream }) => {
      logObj.date = new Date(logObj.date);
      consola[logObj.type](...logObj.args);
    });
  } else {
    /* istanbul ignore next */
    consola.setReporters(new Reporter());
  }

  global.__consolaSet = true;
  global.consola = consola;

  // Delete the loaded consola module from node's cache
  // so new imports use the above global.consola
  delete require.cache[require.resolve('consola')];
}

const consola$1 = consola;

// Copied from Nuxt.Utils
const sequence = function sequence(tasks, fn) {
  return tasks.reduce(
    (promise, task) => promise.then(() => fn(task)),
    Promise.resolve()
  )
};

const Hookable = (Base) => {
  if (!Base) {
    Base = class {};
  }

  return class extends Base {
    initHooks() {
      if (!this._hooks) {
        this._hooks = {};
      }
    }

    hook(name, fn) {
      if (!name || typeof fn !== 'function') {
        return
      }
      this.initHooks();

      this._hooks[name] = this._hooks[name] || [];
      this._hooks[name].push(fn);
    }

    async callHook(name, ...args) {
      if (!this.hasHooks(name)) {
        return
      }
      // debug(`Call ${name} hooks (${this._hooks[name].length})`)
      const ret = [];
      try {
        ret.push(await sequence(this._hooks[name], fn => fn(...args)));
      } catch (err) {
        consola$1.error(`> Error on hook "${name}":`);
        consola$1.error(err.message);
      }
      return ret.length === 1 ? ret[0] : ret
    }

    hasHooks(name) {
      return this._hooks && !!this._hooks[name]
    }
  }
};

class Watchdog extends Hookable() {
  constructor() {
    super();

    this.workers = {};
  }

  *iterator() {
    const workerIds = Object.keys(this.workers);

    let i = 0;
    while (i < workerIds.length) {
      yield this.workers[workerIds[i]];
      i++;
    }
  }

  addInfo(workerId, key, extraInfo) {
    if (arguments.length === 2) {
      extraInfo = key;
      key = undefined;
    }

    if (this.workers[workerId]) {
      if (key) {
        this.workers[workerId][key] = extraInfo;
      } else {
        this.workers[workerId] = Object.assign(this.workers[workerId], extraInfo || {});
      }
    }
  }

  appendInfo(workerId, key, extraInfo) {
    if (this.workers[workerId]) {
      const keyType = typeof this.workers[workerId][key];

      if (keyType === 'undefined') {
        consola$1.error(`Key ${key} is undefined for worker ${workerId}`);
      } else if (keyType === 'string') {
        this.workers[workerId][key] += extraInfo;
      } else if (keyType === 'number') {
        this.workers[workerId][key] += parseInt(extraInfo);
      } else if (Array.isArray(this.workers[workerId][key])) {
        Array.prototype.push.apply(this.workers[workerId][key], extraInfo);
      } else if (keyType === 'object') {
        this.workers[workerId][key] = Object.assign(this.workers[workerId][key], extraInfo || {});
      }
    }
  }

  addWorker(workerId, extraInfo) {
    if (typeof this.workers[workerId] !== 'undefined') {
      consola$1.error(`A worker with workerId ${workerId} is already registered to the watchdog`);
    }

    this.workers[workerId] = Object.assign({
      id: workerId,
      start: process.hrtime(),
      duration: 0,
      signal: 0,
      code: 0,
      routes: 0,
      errors: 0
    }, extraInfo || {});
  }

  exitWorker(workerId, extraInfo) {
    if (this.workers[workerId]) {
      const duration = process.hrtime(this.workers[workerId].start);
      this.workers[workerId].duration = duration[0] * 1E9 + duration[1];

      if (extraInfo) {
        this.addInfo(workerId, extraInfo);
      }
    }
  }

  async countAlive() {
    const Iter = this.iterator();

    let alive = 0;
    let worker;
    while ((worker = Iter.next()) && !worker.done) {
      if (typeof worker.value !== 'undefined') {
        const workerAlive = await this.callHook('isWorkerAlive', worker.value);
        if (workerAlive) {
          alive++;
        }
      }
    }
    return alive
  }

  allDead() {
    const Iter = this.iterator();

    let worker;
    while ((worker = Iter.next()) && !worker.done) {
      if (typeof worker.value !== 'undefined') {
        // let isDead = await this.callHook('isWorkerDead', worker.value)
        const isDead = this.workers[worker.value.id].duration > 0;
        if (!isDead) {
          return false
        }
      }
    }
    return true
  }
}

var commonjsGlobal = typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : typeof self !== 'undefined' ? self : {};

/** Detect free variable `global` from Node.js. */
var freeGlobal = typeof commonjsGlobal == 'object' && commonjsGlobal && commonjsGlobal.Object === Object && commonjsGlobal;

var _freeGlobal = freeGlobal;

/** Detect free variable `self`. */
var freeSelf = typeof self == 'object' && self && self.Object === Object && self;

/** Used as a reference to the global object. */
var root = _freeGlobal || freeSelf || Function('return this')();

var _root = root;

/** Built-in value references. */
var Symbol = _root.Symbol;

var _Symbol = Symbol;

/** Used for built-in method references. */
var objectProto = Object.prototype;

/** Used to check objects for own properties. */
var hasOwnProperty = objectProto.hasOwnProperty;

/**
 * Used to resolve the
 * [`toStringTag`](http://ecma-international.org/ecma-262/7.0/#sec-object.prototype.tostring)
 * of values.
 */
var nativeObjectToString = objectProto.toString;

/** Built-in value references. */
var symToStringTag = _Symbol ? _Symbol.toStringTag : undefined;

/**
 * A specialized version of `baseGetTag` which ignores `Symbol.toStringTag` values.
 *
 * @private
 * @param {*} value The value to query.
 * @returns {string} Returns the raw `toStringTag`.
 */
function getRawTag(value) {
  var isOwn = hasOwnProperty.call(value, symToStringTag),
      tag = value[symToStringTag];

  try {
    value[symToStringTag] = undefined;
    var unmasked = true;
  } catch (e) {}

  var result = nativeObjectToString.call(value);
  if (unmasked) {
    if (isOwn) {
      value[symToStringTag] = tag;
    } else {
      delete value[symToStringTag];
    }
  }
  return result;
}

var _getRawTag = getRawTag;

/** Used for built-in method references. */
var objectProto$1 = Object.prototype;

/**
 * Used to resolve the
 * [`toStringTag`](http://ecma-international.org/ecma-262/7.0/#sec-object.prototype.tostring)
 * of values.
 */
var nativeObjectToString$1 = objectProto$1.toString;

/**
 * Converts `value` to a string using `Object.prototype.toString`.
 *
 * @private
 * @param {*} value The value to convert.
 * @returns {string} Returns the converted string.
 */
function objectToString(value) {
  return nativeObjectToString$1.call(value);
}

var _objectToString = objectToString;

/** `Object#toString` result references. */
var nullTag = '[object Null]',
    undefinedTag = '[object Undefined]';

/** Built-in value references. */
var symToStringTag$1 = _Symbol ? _Symbol.toStringTag : undefined;

/**
 * The base implementation of `getTag` without fallbacks for buggy environments.
 *
 * @private
 * @param {*} value The value to query.
 * @returns {string} Returns the `toStringTag`.
 */
function baseGetTag(value) {
  if (value == null) {
    return value === undefined ? undefinedTag : nullTag;
  }
  return (symToStringTag$1 && symToStringTag$1 in Object(value))
    ? _getRawTag(value)
    : _objectToString(value);
}

var _baseGetTag = baseGetTag;

/**
 * Checks if `value` is the
 * [language type](http://www.ecma-international.org/ecma-262/7.0/#sec-ecmascript-language-types)
 * of `Object`. (e.g. arrays, functions, objects, regexes, `new Number(0)`, and `new String('')`)
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is an object, else `false`.
 * @example
 *
 * _.isObject({});
 * // => true
 *
 * _.isObject([1, 2, 3]);
 * // => true
 *
 * _.isObject(_.noop);
 * // => true
 *
 * _.isObject(null);
 * // => false
 */
function isObject(value) {
  var type = typeof value;
  return value != null && (type == 'object' || type == 'function');
}

var isObject_1 = isObject;

/** `Object#toString` result references. */
var asyncTag = '[object AsyncFunction]',
    funcTag = '[object Function]',
    genTag = '[object GeneratorFunction]',
    proxyTag = '[object Proxy]';

/**
 * Checks if `value` is classified as a `Function` object.
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @category Lang
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a function, else `false`.
 * @example
 *
 * _.isFunction(_);
 * // => true
 *
 * _.isFunction(/abc/);
 * // => false
 */
function isFunction(value) {
  if (!isObject_1(value)) {
    return false;
  }
  // The use of `Object#toString` avoids issues with the `typeof` operator
  // in Safari 9 which returns 'object' for typed arrays and other constructors.
  var tag = _baseGetTag(value);
  return tag == funcTag || tag == genTag || tag == asyncTag || tag == proxyTag;
}

var isFunction_1 = isFunction;

/** Used to detect overreaching core-js shims. */
var coreJsData = _root['__core-js_shared__'];

var _coreJsData = coreJsData;

/** Used to detect methods masquerading as native. */
var maskSrcKey = (function() {
  var uid = /[^.]+$/.exec(_coreJsData && _coreJsData.keys && _coreJsData.keys.IE_PROTO || '');
  return uid ? ('Symbol(src)_1.' + uid) : '';
}());

/**
 * Checks if `func` has its source masked.
 *
 * @private
 * @param {Function} func The function to check.
 * @returns {boolean} Returns `true` if `func` is masked, else `false`.
 */
function isMasked(func) {
  return !!maskSrcKey && (maskSrcKey in func);
}

var _isMasked = isMasked;

/** Used for built-in method references. */
var funcProto = Function.prototype;

/** Used to resolve the decompiled source of functions. */
var funcToString = funcProto.toString;

/**
 * Converts `func` to its source code.
 *
 * @private
 * @param {Function} func The function to convert.
 * @returns {string} Returns the source code.
 */
function toSource(func) {
  if (func != null) {
    try {
      return funcToString.call(func);
    } catch (e) {}
    try {
      return (func + '');
    } catch (e) {}
  }
  return '';
}

var _toSource = toSource;

/**
 * Used to match `RegExp`
 * [syntax characters](http://ecma-international.org/ecma-262/7.0/#sec-patterns).
 */
var reRegExpChar = /[\\^$.*+?()[\]{}|]/g;

/** Used to detect host constructors (Safari). */
var reIsHostCtor = /^\[object .+?Constructor\]$/;

/** Used for built-in method references. */
var funcProto$1 = Function.prototype,
    objectProto$2 = Object.prototype;

/** Used to resolve the decompiled source of functions. */
var funcToString$1 = funcProto$1.toString;

/** Used to check objects for own properties. */
var hasOwnProperty$1 = objectProto$2.hasOwnProperty;

/** Used to detect if a method is native. */
var reIsNative = RegExp('^' +
  funcToString$1.call(hasOwnProperty$1).replace(reRegExpChar, '\\$&')
  .replace(/hasOwnProperty|(function).*?(?=\\\()| for .+?(?=\\\])/g, '$1.*?') + '$'
);

/**
 * The base implementation of `_.isNative` without bad shim checks.
 *
 * @private
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is a native function,
 *  else `false`.
 */
function baseIsNative(value) {
  if (!isObject_1(value) || _isMasked(value)) {
    return false;
  }
  var pattern = isFunction_1(value) ? reIsNative : reIsHostCtor;
  return pattern.test(_toSource(value));
}

var _baseIsNative = baseIsNative;

/**
 * Gets the value at `key` of `object`.
 *
 * @private
 * @param {Object} [object] The object to query.
 * @param {string} key The key of the property to get.
 * @returns {*} Returns the property value.
 */
function getValue(object, key) {
  return object == null ? undefined : object[key];
}

var _getValue = getValue;

/**
 * Gets the native function at `key` of `object`.
 *
 * @private
 * @param {Object} object The object to query.
 * @param {string} key The key of the method to get.
 * @returns {*} Returns the function if it's native, else `undefined`.
 */
function getNative(object, key) {
  var value = _getValue(object, key);
  return _baseIsNative(value) ? value : undefined;
}

var _getNative = getNative;

/* Built-in method references that are verified to be native. */
var nativeCreate = _getNative(Object, 'create');

var _nativeCreate = nativeCreate;

/**
 * Removes all key-value entries from the hash.
 *
 * @private
 * @name clear
 * @memberOf Hash
 */
function hashClear() {
  this.__data__ = _nativeCreate ? _nativeCreate(null) : {};
  this.size = 0;
}

var _hashClear = hashClear;

/**
 * Removes `key` and its value from the hash.
 *
 * @private
 * @name delete
 * @memberOf Hash
 * @param {Object} hash The hash to modify.
 * @param {string} key The key of the value to remove.
 * @returns {boolean} Returns `true` if the entry was removed, else `false`.
 */
function hashDelete(key) {
  var result = this.has(key) && delete this.__data__[key];
  this.size -= result ? 1 : 0;
  return result;
}

var _hashDelete = hashDelete;

/** Used to stand-in for `undefined` hash values. */
var HASH_UNDEFINED = '__lodash_hash_undefined__';

/** Used for built-in method references. */
var objectProto$3 = Object.prototype;

/** Used to check objects for own properties. */
var hasOwnProperty$2 = objectProto$3.hasOwnProperty;

/**
 * Gets the hash value for `key`.
 *
 * @private
 * @name get
 * @memberOf Hash
 * @param {string} key The key of the value to get.
 * @returns {*} Returns the entry value.
 */
function hashGet(key) {
  var data = this.__data__;
  if (_nativeCreate) {
    var result = data[key];
    return result === HASH_UNDEFINED ? undefined : result;
  }
  return hasOwnProperty$2.call(data, key) ? data[key] : undefined;
}

var _hashGet = hashGet;

/** Used for built-in method references. */
var objectProto$4 = Object.prototype;

/** Used to check objects for own properties. */
var hasOwnProperty$3 = objectProto$4.hasOwnProperty;

/**
 * Checks if a hash value for `key` exists.
 *
 * @private
 * @name has
 * @memberOf Hash
 * @param {string} key The key of the entry to check.
 * @returns {boolean} Returns `true` if an entry for `key` exists, else `false`.
 */
function hashHas(key) {
  var data = this.__data__;
  return _nativeCreate ? (data[key] !== undefined) : hasOwnProperty$3.call(data, key);
}

var _hashHas = hashHas;

/** Used to stand-in for `undefined` hash values. */
var HASH_UNDEFINED$1 = '__lodash_hash_undefined__';

/**
 * Sets the hash `key` to `value`.
 *
 * @private
 * @name set
 * @memberOf Hash
 * @param {string} key The key of the value to set.
 * @param {*} value The value to set.
 * @returns {Object} Returns the hash instance.
 */
function hashSet(key, value) {
  var data = this.__data__;
  this.size += this.has(key) ? 0 : 1;
  data[key] = (_nativeCreate && value === undefined) ? HASH_UNDEFINED$1 : value;
  return this;
}

var _hashSet = hashSet;

/**
 * Creates a hash object.
 *
 * @private
 * @constructor
 * @param {Array} [entries] The key-value pairs to cache.
 */
function Hash(entries) {
  var index = -1,
      length = entries == null ? 0 : entries.length;

  this.clear();
  while (++index < length) {
    var entry = entries[index];
    this.set(entry[0], entry[1]);
  }
}

// Add methods to `Hash`.
Hash.prototype.clear = _hashClear;
Hash.prototype['delete'] = _hashDelete;
Hash.prototype.get = _hashGet;
Hash.prototype.has = _hashHas;
Hash.prototype.set = _hashSet;

var _Hash = Hash;

/**
 * Removes all key-value entries from the list cache.
 *
 * @private
 * @name clear
 * @memberOf ListCache
 */
function listCacheClear() {
  this.__data__ = [];
  this.size = 0;
}

var _listCacheClear = listCacheClear;

/**
 * Performs a
 * [`SameValueZero`](http://ecma-international.org/ecma-262/7.0/#sec-samevaluezero)
 * comparison between two values to determine if they are equivalent.
 *
 * @static
 * @memberOf _
 * @since 4.0.0
 * @category Lang
 * @param {*} value The value to compare.
 * @param {*} other The other value to compare.
 * @returns {boolean} Returns `true` if the values are equivalent, else `false`.
 * @example
 *
 * var object = { 'a': 1 };
 * var other = { 'a': 1 };
 *
 * _.eq(object, object);
 * // => true
 *
 * _.eq(object, other);
 * // => false
 *
 * _.eq('a', 'a');
 * // => true
 *
 * _.eq('a', Object('a'));
 * // => false
 *
 * _.eq(NaN, NaN);
 * // => true
 */
function eq(value, other) {
  return value === other || (value !== value && other !== other);
}

var eq_1 = eq;

/**
 * Gets the index at which the `key` is found in `array` of key-value pairs.
 *
 * @private
 * @param {Array} array The array to inspect.
 * @param {*} key The key to search for.
 * @returns {number} Returns the index of the matched value, else `-1`.
 */
function assocIndexOf(array, key) {
  var length = array.length;
  while (length--) {
    if (eq_1(array[length][0], key)) {
      return length;
    }
  }
  return -1;
}

var _assocIndexOf = assocIndexOf;

/** Used for built-in method references. */
var arrayProto = Array.prototype;

/** Built-in value references. */
var splice = arrayProto.splice;

/**
 * Removes `key` and its value from the list cache.
 *
 * @private
 * @name delete
 * @memberOf ListCache
 * @param {string} key The key of the value to remove.
 * @returns {boolean} Returns `true` if the entry was removed, else `false`.
 */
function listCacheDelete(key) {
  var data = this.__data__,
      index = _assocIndexOf(data, key);

  if (index < 0) {
    return false;
  }
  var lastIndex = data.length - 1;
  if (index == lastIndex) {
    data.pop();
  } else {
    splice.call(data, index, 1);
  }
  --this.size;
  return true;
}

var _listCacheDelete = listCacheDelete;

/**
 * Gets the list cache value for `key`.
 *
 * @private
 * @name get
 * @memberOf ListCache
 * @param {string} key The key of the value to get.
 * @returns {*} Returns the entry value.
 */
function listCacheGet(key) {
  var data = this.__data__,
      index = _assocIndexOf(data, key);

  return index < 0 ? undefined : data[index][1];
}

var _listCacheGet = listCacheGet;

/**
 * Checks if a list cache value for `key` exists.
 *
 * @private
 * @name has
 * @memberOf ListCache
 * @param {string} key The key of the entry to check.
 * @returns {boolean} Returns `true` if an entry for `key` exists, else `false`.
 */
function listCacheHas(key) {
  return _assocIndexOf(this.__data__, key) > -1;
}

var _listCacheHas = listCacheHas;

/**
 * Sets the list cache `key` to `value`.
 *
 * @private
 * @name set
 * @memberOf ListCache
 * @param {string} key The key of the value to set.
 * @param {*} value The value to set.
 * @returns {Object} Returns the list cache instance.
 */
function listCacheSet(key, value) {
  var data = this.__data__,
      index = _assocIndexOf(data, key);

  if (index < 0) {
    ++this.size;
    data.push([key, value]);
  } else {
    data[index][1] = value;
  }
  return this;
}

var _listCacheSet = listCacheSet;

/**
 * Creates an list cache object.
 *
 * @private
 * @constructor
 * @param {Array} [entries] The key-value pairs to cache.
 */
function ListCache(entries) {
  var index = -1,
      length = entries == null ? 0 : entries.length;

  this.clear();
  while (++index < length) {
    var entry = entries[index];
    this.set(entry[0], entry[1]);
  }
}

// Add methods to `ListCache`.
ListCache.prototype.clear = _listCacheClear;
ListCache.prototype['delete'] = _listCacheDelete;
ListCache.prototype.get = _listCacheGet;
ListCache.prototype.has = _listCacheHas;
ListCache.prototype.set = _listCacheSet;

var _ListCache = ListCache;

/* Built-in method references that are verified to be native. */
var Map = _getNative(_root, 'Map');

var _Map = Map;

/**
 * Removes all key-value entries from the map.
 *
 * @private
 * @name clear
 * @memberOf MapCache
 */
function mapCacheClear() {
  this.size = 0;
  this.__data__ = {
    'hash': new _Hash,
    'map': new (_Map || _ListCache),
    'string': new _Hash
  };
}

var _mapCacheClear = mapCacheClear;

/**
 * Checks if `value` is suitable for use as unique object key.
 *
 * @private
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is suitable, else `false`.
 */
function isKeyable(value) {
  var type = typeof value;
  return (type == 'string' || type == 'number' || type == 'symbol' || type == 'boolean')
    ? (value !== '__proto__')
    : (value === null);
}

var _isKeyable = isKeyable;

/**
 * Gets the data for `map`.
 *
 * @private
 * @param {Object} map The map to query.
 * @param {string} key The reference key.
 * @returns {*} Returns the map data.
 */
function getMapData(map, key) {
  var data = map.__data__;
  return _isKeyable(key)
    ? data[typeof key == 'string' ? 'string' : 'hash']
    : data.map;
}

var _getMapData = getMapData;

/**
 * Removes `key` and its value from the map.
 *
 * @private
 * @name delete
 * @memberOf MapCache
 * @param {string} key The key of the value to remove.
 * @returns {boolean} Returns `true` if the entry was removed, else `false`.
 */
function mapCacheDelete(key) {
  var result = _getMapData(this, key)['delete'](key);
  this.size -= result ? 1 : 0;
  return result;
}

var _mapCacheDelete = mapCacheDelete;

/**
 * Gets the map value for `key`.
 *
 * @private
 * @name get
 * @memberOf MapCache
 * @param {string} key The key of the value to get.
 * @returns {*} Returns the entry value.
 */
function mapCacheGet(key) {
  return _getMapData(this, key).get(key);
}

var _mapCacheGet = mapCacheGet;

/**
 * Checks if a map value for `key` exists.
 *
 * @private
 * @name has
 * @memberOf MapCache
 * @param {string} key The key of the entry to check.
 * @returns {boolean} Returns `true` if an entry for `key` exists, else `false`.
 */
function mapCacheHas(key) {
  return _getMapData(this, key).has(key);
}

var _mapCacheHas = mapCacheHas;

/**
 * Sets the map `key` to `value`.
 *
 * @private
 * @name set
 * @memberOf MapCache
 * @param {string} key The key of the value to set.
 * @param {*} value The value to set.
 * @returns {Object} Returns the map cache instance.
 */
function mapCacheSet(key, value) {
  var data = _getMapData(this, key),
      size = data.size;

  data.set(key, value);
  this.size += data.size == size ? 0 : 1;
  return this;
}

var _mapCacheSet = mapCacheSet;

/**
 * Creates a map cache object to store key-value pairs.
 *
 * @private
 * @constructor
 * @param {Array} [entries] The key-value pairs to cache.
 */
function MapCache(entries) {
  var index = -1,
      length = entries == null ? 0 : entries.length;

  this.clear();
  while (++index < length) {
    var entry = entries[index];
    this.set(entry[0], entry[1]);
  }
}

// Add methods to `MapCache`.
MapCache.prototype.clear = _mapCacheClear;
MapCache.prototype['delete'] = _mapCacheDelete;
MapCache.prototype.get = _mapCacheGet;
MapCache.prototype.has = _mapCacheHas;
MapCache.prototype.set = _mapCacheSet;

var _MapCache = MapCache;

/** Used to stand-in for `undefined` hash values. */
var HASH_UNDEFINED$2 = '__lodash_hash_undefined__';

/**
 * Adds `value` to the array cache.
 *
 * @private
 * @name add
 * @memberOf SetCache
 * @alias push
 * @param {*} value The value to cache.
 * @returns {Object} Returns the cache instance.
 */
function setCacheAdd(value) {
  this.__data__.set(value, HASH_UNDEFINED$2);
  return this;
}

var _setCacheAdd = setCacheAdd;

/**
 * Checks if `value` is in the array cache.
 *
 * @private
 * @name has
 * @memberOf SetCache
 * @param {*} value The value to search for.
 * @returns {number} Returns `true` if `value` is found, else `false`.
 */
function setCacheHas(value) {
  return this.__data__.has(value);
}

var _setCacheHas = setCacheHas;

/**
 *
 * Creates an array cache object to store unique values.
 *
 * @private
 * @constructor
 * @param {Array} [values] The values to cache.
 */
function SetCache(values) {
  var index = -1,
      length = values == null ? 0 : values.length;

  this.__data__ = new _MapCache;
  while (++index < length) {
    this.add(values[index]);
  }
}

// Add methods to `SetCache`.
SetCache.prototype.add = SetCache.prototype.push = _setCacheAdd;
SetCache.prototype.has = _setCacheHas;

var _SetCache = SetCache;

/**
 * The base implementation of `_.findIndex` and `_.findLastIndex` without
 * support for iteratee shorthands.
 *
 * @private
 * @param {Array} array The array to inspect.
 * @param {Function} predicate The function invoked per iteration.
 * @param {number} fromIndex The index to search from.
 * @param {boolean} [fromRight] Specify iterating from right to left.
 * @returns {number} Returns the index of the matched value, else `-1`.
 */
function baseFindIndex(array, predicate, fromIndex, fromRight) {
  var length = array.length,
      index = fromIndex + (fromRight ? 1 : -1);

  while ((fromRight ? index-- : ++index < length)) {
    if (predicate(array[index], index, array)) {
      return index;
    }
  }
  return -1;
}

var _baseFindIndex = baseFindIndex;

/**
 * The base implementation of `_.isNaN` without support for number objects.
 *
 * @private
 * @param {*} value The value to check.
 * @returns {boolean} Returns `true` if `value` is `NaN`, else `false`.
 */
function baseIsNaN(value) {
  return value !== value;
}

var _baseIsNaN = baseIsNaN;

/**
 * A specialized version of `_.indexOf` which performs strict equality
 * comparisons of values, i.e. `===`.
 *
 * @private
 * @param {Array} array The array to inspect.
 * @param {*} value The value to search for.
 * @param {number} fromIndex The index to search from.
 * @returns {number} Returns the index of the matched value, else `-1`.
 */
function strictIndexOf(array, value, fromIndex) {
  var index = fromIndex - 1,
      length = array.length;

  while (++index < length) {
    if (array[index] === value) {
      return index;
    }
  }
  return -1;
}

var _strictIndexOf = strictIndexOf;

/**
 * The base implementation of `_.indexOf` without `fromIndex` bounds checks.
 *
 * @private
 * @param {Array} array The array to inspect.
 * @param {*} value The value to search for.
 * @param {number} fromIndex The index to search from.
 * @returns {number} Returns the index of the matched value, else `-1`.
 */
function baseIndexOf(array, value, fromIndex) {
  return value === value
    ? _strictIndexOf(array, value, fromIndex)
    : _baseFindIndex(array, _baseIsNaN, fromIndex);
}

var _baseIndexOf = baseIndexOf;

/**
 * A specialized version of `_.includes` for arrays without support for
 * specifying an index to search from.
 *
 * @private
 * @param {Array} [array] The array to inspect.
 * @param {*} target The value to search for.
 * @returns {boolean} Returns `true` if `target` is found, else `false`.
 */
function arrayIncludes(array, value) {
  var length = array == null ? 0 : array.length;
  return !!length && _baseIndexOf(array, value, 0) > -1;
}

var _arrayIncludes = arrayIncludes;

/**
 * This function is like `arrayIncludes` except that it accepts a comparator.
 *
 * @private
 * @param {Array} [array] The array to inspect.
 * @param {*} target The value to search for.
 * @param {Function} comparator The comparator invoked per element.
 * @returns {boolean} Returns `true` if `target` is found, else `false`.
 */
function arrayIncludesWith(array, value, comparator) {
  var index = -1,
      length = array == null ? 0 : array.length;

  while (++index < length) {
    if (comparator(value, array[index])) {
      return true;
    }
  }
  return false;
}

var _arrayIncludesWith = arrayIncludesWith;

/**
 * Checks if a `cache` value for `key` exists.
 *
 * @private
 * @param {Object} cache The cache to query.
 * @param {string} key The key of the entry to check.
 * @returns {boolean} Returns `true` if an entry for `key` exists, else `false`.
 */
function cacheHas(cache, key) {
  return cache.has(key);
}

var _cacheHas = cacheHas;

/* Built-in method references that are verified to be native. */
var Set = _getNative(_root, 'Set');

var _Set = Set;

/**
 * This method returns `undefined`.
 *
 * @static
 * @memberOf _
 * @since 2.3.0
 * @category Util
 * @example
 *
 * _.times(2, _.noop);
 * // => [undefined, undefined]
 */
function noop() {
  // No operation performed.
}

var noop_1 = noop;

/**
 * Converts `set` to an array of its values.
 *
 * @private
 * @param {Object} set The set to convert.
 * @returns {Array} Returns the values.
 */
function setToArray(set) {
  var index = -1,
      result = Array(set.size);

  set.forEach(function(value) {
    result[++index] = value;
  });
  return result;
}

var _setToArray = setToArray;

/** Used as references for various `Number` constants. */
var INFINITY = 1 / 0;

/**
 * Creates a set object of `values`.
 *
 * @private
 * @param {Array} values The values to add to the set.
 * @returns {Object} Returns the new set.
 */
var createSet = !(_Set && (1 / _setToArray(new _Set([,-0]))[1]) == INFINITY) ? noop_1 : function(values) {
  return new _Set(values);
};

var _createSet = createSet;

/** Used as the size to enable large array optimizations. */
var LARGE_ARRAY_SIZE = 200;

/**
 * The base implementation of `_.uniqBy` without support for iteratee shorthands.
 *
 * @private
 * @param {Array} array The array to inspect.
 * @param {Function} [iteratee] The iteratee invoked per element.
 * @param {Function} [comparator] The comparator invoked per element.
 * @returns {Array} Returns the new duplicate free array.
 */
function baseUniq(array, iteratee, comparator) {
  var index = -1,
      includes = _arrayIncludes,
      length = array.length,
      isCommon = true,
      result = [],
      seen = result;

  if (comparator) {
    isCommon = false;
    includes = _arrayIncludesWith;
  }
  else if (length >= LARGE_ARRAY_SIZE) {
    var set = iteratee ? null : _createSet(array);
    if (set) {
      return _setToArray(set);
    }
    isCommon = false;
    includes = _cacheHas;
    seen = new _SetCache;
  }
  else {
    seen = iteratee ? [] : result;
  }
  outer:
  while (++index < length) {
    var value = array[index],
        computed = iteratee ? iteratee(value) : value;

    value = (comparator || value !== 0) ? value : 0;
    if (isCommon && computed === computed) {
      var seenIndex = seen.length;
      while (seenIndex--) {
        if (seen[seenIndex] === computed) {
          continue outer;
        }
      }
      if (iteratee) {
        seen.push(computed);
      }
      result.push(value);
    }
    else if (!includes(seen, computed, comparator)) {
      if (seen !== result) {
        seen.push(computed);
      }
      result.push(value);
    }
  }
  return result;
}

var _baseUniq = baseUniq;

/**
 * Creates a duplicate-free version of an array, using
 * [`SameValueZero`](http://ecma-international.org/ecma-262/7.0/#sec-samevaluezero)
 * for equality comparisons, in which only the first occurrence of each element
 * is kept. The order of result values is determined by the order they occur
 * in the array.
 *
 * @static
 * @memberOf _
 * @since 0.1.0
 * @category Array
 * @param {Array} array The array to inspect.
 * @returns {Array} Returns the new duplicate free array.
 * @example
 *
 * _.uniq([2, 1, 2]);
 * // => [2, 1]
 */
function uniq(array) {
  return (array && array.length) ? _baseUniq(array) : [];
}

var uniq_1 = uniq;

const localNodeModules = path.resolve(process.cwd(), 'node_modules');

// Prefer importing modules from local node_modules (for NPX and global bin)
async function _import(modulePath) {
  let m;
  for (const mp of [ path.resolve(localNodeModules, modulePath), modulePath ]) {
    try {
      m = await new Promise(function (resolve) { resolve(_interopNamespace(require(mp))); });
    } catch (e) {
      /* istanbul ignore next */
      if (e.code !== 'MODULE_NOT_FOUND') {
        throw e
      } else if (mp === modulePath) {
        consola$2.fatal(
          `Module ${modulePath} not found.\n\n`,
          `Please install missing dependency:\n\n`,
          `Using npm:  npm i ${modulePath}\n\n`,
          `Using yarn: yarn add ${modulePath}`
        );
      }
    }
  }
  return m
}

const builder = () => _import('@nuxt/builder');
const webpack = () => _import('@nuxt/webpack');
const generator = () => _import('@nuxt/generator');
const core = () => _import('@nuxt/core');

const getNuxt = async function getNuxt(options) {
  const { Nuxt } = await core();
  const nuxt = new Nuxt(options);
  await nuxt.ready();
  return nuxt
};

const getBuilder = async function getBuilder(nuxt) {
  const { Builder } = await builder();
  const { BundleBuilder } = await webpack();
  return new Builder(nuxt, BundleBuilder)
};

const getGenerator = async function getGenerator(nuxt) {
  const { Generator } = await generator();
  const builder = await getBuilder(nuxt);
  return new Generator(nuxt, builder)
};

class Master extends Hookable() {
  constructor(options, { workerCount, workerConcurrency, failOnPageError, adjustLogLevel }) {
    super();

    this.options = options;

    this.watchdog = new Watchdog();
    this.startTime = process.hrtime();

    this.workerCount = parseInt(workerCount);
    this.workerConcurrency = parseInt(workerConcurrency);
    this.failOnPageError = failOnPageError;

    if (adjustLogLevel) {
      consola$1.level = consola$1._defaultLevel + adjustLogLevel;
      this.options.__workerLogLevel = consola$1.level;
    }

    this.routes = [];
    this.errors = [];
  }

  async init() {
    if (this.generator) {
      return
    }

    const level = consola$1.level;
    const nuxt = await getNuxt(this.options);
    consola$1.level = level; // ignore whatever Nuxt thinks the level should be

    this.generator = await getGenerator(nuxt);

    this.workerCount = this.workerCount || parseInt(nuxt.options.generate.workers) || require('os').cpus().length;
    this.workerConcurrency = this.workerConcurrency || parseInt(nuxt.options.generate.workerConcurrency) || 500;
  }

  async run({ build, params } = {}) {
    await this.init();

    if (build) {
      await this.build();
      await this.callHook('built', params);
    } else {
      await this.initiate();
    }

    await this.getRoutes(params);

    if (this.routes.length > 0) {
      await this.startWorkers();
    } else {
      consola$1.warn('No routes so not starting workers');
    }
  }

  async initiate(build) {
    if (!build) build = false;
    await this.generator.initiate({ build: build, init: build });
  }

  async build() {
    await this.initiate(true);
  }

  async getRoutes(params) {
    try {
      const routes = await this.generator.initRoutes(params);
      if (routes.length) {
        // add routes to any existing routes
        Array.prototype.push.apply(this.routes, routes);
        this.routes = uniq_1(this.routes);
      }
      return true
    } catch (e) {
    }
    return false
  }

  calculateBatchSize() {
    // Even the load between workers
    let workerConcurrency = this.workerConcurrency;
    if (this.routes.length < this.workerCount * this.workerConcurrency) {
      workerConcurrency = Math.ceil(this.routes.length / this.workerCount);
    }

    return workerConcurrency
  }

  getBatchRoutes() {
    const batchSize = this.calculateBatchSize();
    const routes = this.routes.splice(0, batchSize);

    return routes
  }

  async done(workerInfo) {
    await this.generator.afterGenerate();

    let duration = process.hrtime(this.startTime);
    duration = Math.round((duration[0] * 1E9 + duration[1]) / 1E8) / 10;

    const info = {
      duration: duration,
      errors: this.errors,
      workerInfo: workerInfo || this.watchdog.workers
    };

    if (this.options.generate && typeof this.options.generate.done === 'function') {
      await this.options.generate.done(info);
    }

    await this.callHook('done', info);

    this.errors = [];
  }

  startWorkers() {
    consola$1.error('Should be implemented by a derived class');
    return false
  }
}

class Worker extends Hookable() {
  constructor(options, { failOnPageError } = {}) {
    super();
    this.options = options;
    this.id = -1;

    this.failOnPageError = failOnPageError;

    if (this.options.__workerLogLevel) {
      consola$1.level = this.options.__workerLogLevel;
    }
  }

  setId(id) {
    this.id = id;
  }

  async init() {
    /* istanbul ignore next */
    if (this.generator) {
      return
    }

    const level = consola$1.level;
    const nuxt = await getNuxt(this.options);
    consola$1.level = level; // ignore whatever Nuxt thinks the level should be

    this.generator = await getGenerator(nuxt);
  }

  async run() {
    await this.init();

    await this.generator.initiate({ build: false, init: false });
  }

  async generateRoutes(routes) {
    let errors = [];

    try {
      errors = await this.generator.generateRoutes(routes);
    } catch (err) {
      consola$1.error(`Worker ${process.pid}: Exception while generating routes, exiting`);
      consola$1.error('' + err);
      throw err
    }

    return errors
  }
}

class Master$1 extends Master {
  constructor(options, { workerCount, workerConcurrency, failOnPageError, setup, adjustLogLevel } = {}) {
    super(options, { adjustLogLevel, workerCount, failOnPageError, workerConcurrency });

    if (setup) {
      cluster__default.setupMaster(setup);
    }

    cluster__default.on('fork', this.onFork.bind(this));
    cluster__default.on('exit', this.onExit.bind(this));

    global._ngc_log_tag = 'master';

    messaging.on(Commands.sendRoutes, (data, senderId, worker) => {
      this.sendRoutes(senderId, worker);
    });
    messaging.on(Commands.sendErrors, (data, senderId, worker) => {
      this.saveErrors(senderId, worker, data);
    });

    this.watchdog.hook('isWorkerAlive', (worker) => {
      return typeof cluster__default.workers[worker.id] !== 'undefined' && cluster__default.workers[worker.id].isConnected()
    });
  }

  async getRoutes(params) {
    consola$1.master(`retrieving routes`);

    const success = await super.getRoutes(params);

    if (success) {
      consola$1.master(`${this.routes.length} routes will be generated`);
    }
  }

  sendRoutes(senderId, worker) {
    const routes = this.getBatchRoutes();

    if (!routes.length) {
      consola$1.master(`no more routes, exiting worker ${worker.id}`);

      worker.disconnect();
    } else {
      consola$1.cluster(`sending ${routes.length} routes to worker ${worker.id}`);

      this.watchdog.appendInfo(worker.id, 'routes', routes.length);

      messaging.send(senderId, Commands.sendRoutes, routes);
    }
  }

  saveErrors(senderId, worker, args) {
    if (typeof args !== 'undefined' && args.length) {
      Array.prototype.push.apply(this.errors, args);
      this.watchdog.appendInfo(worker.id, 'errors', args.length);
    }
  }

  async done() {
    const Iter = this.watchdog.iterator();

    let worker;
    while ((worker = Iter.next()) && !worker.done) {
      worker = worker.value;

      let workerMsg = `worker ${worker.id} generated ${worker.routes} routes in ${Math.round(worker.duration / 1E8) / 10}s`;
      if (worker.errors > 0) {
        workerMsg += ` with ${worker.errors} error(s)`;
      }
      consola$1.cluster(workerMsg);
    }

    await super.done();
  }

  async startWorkers() {
    // Dont start more workers then there are routes
    const maxWorkerCount = Math.min(this.workerCount, this.routes.length);

    for (let i = await this.watchdog.countAlive(); i < maxWorkerCount; i++) {
      cluster__default.fork({
        args: JSON.stringify({
          options: this.options,
          cliOptions: {
            failOnPageError: this.failOnPageError
          }
        })
      });
    }
  }

  onFork(worker) {
    const pid = worker.process.pid;
    consola$1.master(`worker ${worker.id} started with pid ${pid}`);

    this.watchdog.addWorker(worker.id, { pid });
  }

  async onExit(worker, code, signal) {
    const workerId = worker.id;

    this.watchdog.exitWorker(workerId, { code, signal });

    let message = `worker ${workerId} exited`;

    let fatal = false;
    if (code) {
      message += ` with status code ${code}`;
      fatal = true;
    }

    if (signal) {
      message += ` by signal ${signal}`;
      fatal = true;
    }

    if (fatal) {
      consola$1.fatal(message);
    } else {
      consola$1.master(message);
    }

    const allDead = await this.watchdog.allDead();
    if (allDead) {
      await this.done();
    }
  }
}

class Worker$1 extends Worker {
  constructor(options, cliOptions = {}) {
    super(options, cliOptions);

    if (cluster__default.isWorker) {
      this.setId(cluster__default.worker.id);
    }

    global._ngc_log_tag = `worker ${this.id}`;

    messaging.alias = `worker ${this.id}`;
    messaging.on(Commands.sendRoutes, (data) => {
      /* istanbul ignore next */
      this.generateRoutes(data);
    });
  }

  static start() {
    const args = JSON.parse(process.env.args);

    const worker = new Worker$1(args.options, args.cliOptions);
    worker.run();
    return worker
  }

  async init() {
    await super.init();

    let renderingStartTime;
    /* istanbul ignore next */
    if (consola$1.level > 3) {
      const debug = consola$1.debug;
      consola$1.debug = (msg) => {
        if (msg.startsWith('Rendering url')) {
          renderingStartTime = process.hrtime();
        }
        debug(msg);
      };
    }

    this.generator.nuxt.hook('generate:routeCreated', ({ route, path, errors }) => {
      let durationMessage = '';
      if (consola$1.level > 3) {
        const taken = process.hrtime(renderingStartTime);
        const duration = Math.round((taken[0] * 1e9 + taken[1]) / 1e6);
        durationMessage += ` (${duration}ms)`;
      }
      path = path.replace(this.generator.distPath, '');

      if (errors.length) {
        consola$1.error(`error generating: ${path}` + durationMessage);
      } else {
        consola$1.success(`generated: ${path}` + durationMessage);
      }
    });
  }

  async run() {
    await super.run();

    messaging.send('master', Commands.sendRoutes);
  }

  async generateRoutes(args) {
    const routes = args;
    consola$1.cluster(`received ${routes.length} routes`);

    let errors;
    try {
      errors = await super.generateRoutes(routes);
    } catch (e) {
      /* istanbul ignore next */
      if (cluster__default.isWorker) {
        process.exit(1);
      }
    }

    if (errors && errors.length) {
      errors = errors.map((error) => {
        error.workerId = this.id;

        /* istanbul ignore next */
        if (error.type === 'unhandled') {
          // convert error stack to a string already, we cant send a stack object to the master process
          error.error = { stack: '' + error.error.stack };

          if (this.failOnPageError) {
            consola$1.fatal(`Unhandled page error occured for route ${error.route}`);
          }
        }
        return error
      });

      messaging.send(null, Commands.sendErrors, errors);
    }

    messaging.send(null, Commands.sendRoutes);
  }
}



const Cluster = /*#__PURE__*/Object.freeze({
  __proto__: null,
  Master: Master$1,
  Worker: Worker$1
});

module.exports = Cluster;
//# sourceMappingURL=generator.js.map
