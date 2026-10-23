async function createJabcode(moduleArg = {}) {
  var Module = moduleArg;
  var quit_ = (status, toThrow) => {
    throw toThrow;
  };
  var out = console.log.bind(console);
  var err = console.error.bind(console);
  var ABORT = false;
  var EXITSTATUS;
  function getMemoryBuffer() {
    return wasmMemory.buffer;
  }
  function updateMemoryViews() {
    if (HEAP8?.buffer?.resizable) return;
    var b = getMemoryBuffer();
    HEAP8 = new Int8Array(b);
    Module['HEAPU8'] = HEAPU8 = new Uint8Array(b);
    HEAPU32 = new Uint32Array(b);
  }
  function preRun() {
    var preRun = Module['preRun'];
    if (preRun) {
      if (typeof preRun === 'function') preRun = [preRun];
      onPreRuns.push(...preRun);
    }
    callRuntimeCallbacks(onPreRuns);
  }
  function initRuntime() {
    0;
    wasmExports['h']();
  }
  function postRun() {
    var postRun = Module['postRun'];
    if (postRun) {
      if (typeof postRun === 'function') postRun = [postRun];
      onPostRuns.push(...postRun);
    }
    callRuntimeCallbacks(onPostRuns);
  }
  function abort(what) {
    Module['onAbort']?.(what);
    what = `Aborted(${what})`;
    err(what);
    ABORT = true;
    what += '. Build with -sASSERTIONS for more info.';
    throw new WebAssembly.RuntimeError(what);
  }
  function getWasmImports() {
    var imports = {a: wasmImports};
    return imports;
  }
  class ExitStatus {
    name = 'ExitStatus';
    constructor(status) {
      this.message = `Program terminated with exit(${status})`;
      this.status = status;
    }
  }
  var HEAP8;
  var callRuntimeCallbacks = callbacks => {
    while (callbacks.length > 0) callbacks.shift()(Module);
  };
  var onPostRuns = [];
  var onPreRuns = [];
  var noExitRuntime = true;
  var runtimeKeepaliveCounter = 0;
  var timers = {};
  var handleException = e => {
    if (e instanceof ExitStatus || e == 'unwind') return EXITSTATUS;
    quit_(1, e);
  };
  var keepRuntimeAlive = () => noExitRuntime || runtimeKeepaliveCounter > 0;
  var _proc_exit = code => {
    EXITSTATUS = code;
    if (!keepRuntimeAlive()) {
      Module['onExit']?.(code);
      ABORT = true;
    }
    quit_(code, new ExitStatus(code));
  };
  var _exit = status => {
    EXITSTATUS = status;
    _proc_exit(status);
  };
  var maybeExit = () => {
    if (!keepRuntimeAlive())
      try {
        _exit(EXITSTATUS);
      } catch (e) {
        handleException(e);
      }
  };
  var callUserCallback = (func, ...args) => {
    if (ABORT) return;
    try {
      return func(...args);
    } catch (e) {
      handleException(e);
    } finally {
      maybeExit();
    }
  };
  var _emscripten_get_now = () => performance.now();
  var getHeapMax = () => 2147483648;
  var alignMemory = (size, alignment) => Math.ceil(size / alignment) * alignment;
  var growMemory = size => {
    var oldHeapSize = wasmMemory.buffer.byteLength;
    var pages = ((size - oldHeapSize + 65535) / 65536) | 0;
    try {
      wasmMemory.grow(pages);
      updateMemoryViews();
      return 1;
    } catch (e) {}
  };
  var HEAPU8;
  var printCharBuffers = [null, [], []];
  var UTF8Decoder = globalThis.TextDecoder && new TextDecoder();
  var findStringEnd = (heapOrArray, idx, maxBytesToRead, ignoreNul) => {
    var maxIdx = idx + maxBytesToRead;
    if (ignoreNul) return maxIdx;
    while (heapOrArray[idx] && !(idx >= maxIdx)) ++idx;
    return idx;
  };
  var UTF8ArrayToString = (heapOrArray, idx = 0, maxBytesToRead, ignoreNul) => {
    var endPtr = findStringEnd(heapOrArray, idx, maxBytesToRead, ignoreNul);
    if (endPtr - idx > 16 && heapOrArray.buffer && UTF8Decoder) return UTF8Decoder.decode(heapOrArray.subarray(idx, endPtr));
    var str = '';
    while (idx < endPtr) {
      var u0 = heapOrArray[idx++];
      if (!(u0 & 128)) {
        str += String.fromCharCode(u0);
        continue;
      }
      var u1 = heapOrArray[idx++] & 63;
      if ((u0 & 224) == 192) {
        str += String.fromCharCode(((u0 & 31) << 6) | u1);
        continue;
      }
      var u2 = heapOrArray[idx++] & 63;
      if ((u0 & 240) == 224) u0 = ((u0 & 15) << 12) | (u1 << 6) | u2;
      else u0 = ((u0 & 7) << 18) | (u1 << 12) | (u2 << 6) | (heapOrArray[idx++] & 63);
      if (u0 < 65536) str += String.fromCharCode(u0);
      else {
        var ch = u0 - 65536;
        str += String.fromCharCode(55296 | (ch >> 10), 56320 | (ch & 1023));
      }
    }
    return str;
  };
  var printChar = (stream, curr) => {
    var buffer = printCharBuffers[stream];
    if (!curr || curr === 10) {
      (stream === 1 ? out : err)(UTF8ArrayToString(buffer));
      buffer.length = 0;
    } else buffer.push(curr);
  };
  var HEAPU32;
  if (Module['noExitRuntime']) noExitRuntime = Module['noExitRuntime'];
  if (Module['print']) out = Module['print'];
  if (Module['printErr']) err = Module['printErr'];
  if (Module['arguments']) Module['arguments'];
  if (Module['thisProgram']) Module['thisProgram'];
  var preInit = Module['preInit'];
  if (preInit) {
    if (typeof preInit === 'function') Module['preInit'] = preInit = [preInit];
    while (preInit.length > 0) preInit.shift()();
  }
  var __emscripten_timeout, wasmMemory;
  function assignWasmExports(wasmExports) {
    Module['_malloc'] = wasmExports['i'];
    Module['_free'] = wasmExports['j'];
    Module['_jab_wasm_free'] = wasmExports['k'];
    Module['_jab_wasm_encode'] = wasmExports['l'];
    Module['_jab_wasm_bitmap_width'] = wasmExports['m'];
    Module['_jab_wasm_bitmap_height'] = wasmExports['n'];
    Module['_jab_wasm_bitmap_pixels'] = wasmExports['o'];
    Module['_jab_wasm_decode'] = wasmExports['p'];
    Module['_jab_wasm_decode_status'] = wasmExports['q'];
    Module['_jab_wasm_result_length'] = wasmExports['r'];
    Module['_jab_wasm_result_data'] = wasmExports['s'];
    __emscripten_timeout = wasmExports['t'];
    wasmMemory = wasmExports['g'];
    wasmExports['__indirect_function_table'];
  }
  var wasmImports = {
    f: () => abort(''),
    e: () => {
      noExitRuntime = false;
      runtimeKeepaliveCounter = 0;
    },
    a: (which, timeout_ms) => {
      if (timers[which]) {
        clearTimeout(timers[which].id);
        delete timers[which];
      }
      if (!timeout_ms) return 0;
      var id = setTimeout(() => {
        delete timers[which];
        callUserCallback(__emscripten_timeout, which, _emscripten_get_now());
      }, timeout_ms);
      timers[which] = {id, timeout_ms};
      return 0;
    },
    b: requestedSize => {
      var oldSize = HEAPU8.length;
      requestedSize >>>= 0;
      var maxHeapSize = getHeapMax();
      if (requestedSize > maxHeapSize) return false;
      for (var cutDown = 1; cutDown <= 4; cutDown *= 2) {
        var overGrownHeapSize = oldSize * (1 + 0.2 / cutDown);
        overGrownHeapSize = Math.min(overGrownHeapSize, requestedSize + 100663296);
        var newSize = Math.min(maxHeapSize, alignMemory(Math.max(requestedSize, overGrownHeapSize), 65536));
        var replacement = growMemory(newSize);
        if (replacement) return true;
      }
      return false;
    },
    c: (fd, iov, iovcnt, pnum) => {
      var num = 0;
      for (var i = 0; i < iovcnt; i++) {
        var ptr = HEAPU32[iov >> 2];
        var len = HEAPU32[(iov + 4) >> 2];
        iov += 8;
        for (var j = 0; j < len; j++) printChar(fd, HEAPU8[ptr + j]);
        num += len;
      }
      HEAPU32[pnum >> 2] = num;
      return 0;
    },
    d: _proc_exit,
  };
  var wasmExports;
  wasmExports = await (async function () {
    function receiveInstance(instance) {
      wasmExports = instance.exports;
      assignWasmExports(wasmExports);
      updateMemoryViews();
      return wasmExports;
    }
    var info = getWasmImports();
    var instantiateWasm = Module['instantiateWasm'];
    if (instantiateWasm)
      return new Promise(resolve => {
        instantiateWasm(info, inst => resolve(receiveInstance(inst)));
      });
    throw new Error('jabcode: pass an instantiateWasm option with the precompiled WebAssembly.Module (see index.js)');
  })();
  await (async function () {
    preRun();
    var setStatus = Module['setStatus'];
    if (setStatus) {
      setStatus('Running...');
      await new Promise(resolve => setTimeout(resolve, 1));
      setTimeout(setStatus, 1, '');
    }
    if (ABORT) return;
    initRuntime();
    Module['onRuntimeInitialized']?.();
    postRun();
  })();
  return Module;
}
export default createJabcode;
