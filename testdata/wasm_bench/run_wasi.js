const {WASI}=require('node:wasi');const fs=require('fs');
const wasi=new WASI({version:'preview1',args:['bench',...process.argv.slice(3)],env:{},preopens:{'/work':process.argv[2]}});
WebAssembly.instantiate(fs.readFileSync(process.argv[2]+'/bench.wasm'),wasi.getImportObject()).then(({instance})=>{wasi.start(instance);});
