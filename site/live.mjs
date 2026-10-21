export const ENDPOINTS = Object.freeze({mainnet:'https://api.hyperliquid.xyz/info',testnet:'https://api.hyperliquid-testnet.xyz/info'});
export const LIVE_TTL_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 8_000;

export class ApiFailure extends Error { constructor(code,message) { super(message); this.code=code; } }
const integer = x => Number.isSafeInteger(x) && x >= 0;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);

export function validateLiveEvidence({network,dex,registry,meta,spot,registryAfter,metaAfter,spotAfter,startedAt,finishedAt}, now=Date.now()) {
  if (!ENDPOINTS[network]) return {ok:false,reasonCode:'NETWORK_MISMATCH',explanation:'The API network does not match the selected network.'};
  if (!integer(startedAt) || !integer(finishedAt) || finishedAt<startedAt || finishedAt-startedAt>20_000 || Math.abs(now-finishedAt)>60_000)
    return {ok:false,reasonCode:'SNAPSHOT_STALE',explanation:'The metadata fetch is too old or took too long.'};
  if (!same(registry,registryAfter) || !same(meta,metaAfter) || !same(spot,spotAfter))
    return {ok:false,reasonCode:'SNAPSHOT_INCONSISTENT',explanation:'Public metadata changed between bounded reads.'};
  if (!Array.isArray(registry) || registry[0]!==null || registry.length>1000 || registry.slice(1).some(x=>!x || typeof x.name!=='string') ||
      new Set(registry.slice(1).map(x=>x.name)).size!==registry.length-1)
    return {ok:false,reasonCode:'SCHEMA_INCOMPLETE',explanation:'The DEX registry is missing or malformed.'};
  const position=dex===''?0:registry.findIndex((x,i)=>i>0&&x.name===dex);
  if (position<0) return {ok:false,reasonCode:'DEX_NOT_FOUND',explanation:'The DEX is absent from the current registry.'};
  if (!meta || !Array.isArray(meta.universe) || meta.universe.length>10_000 || meta.universe.some(x=>!x||typeof x.name!=='string') ||
      new Set(meta.universe.map(x=>x.name)).size!==meta.universe.length || !spot || !Array.isArray(spot.tokens))
    return {ok:false,reasonCode:'SCHEMA_INCOMPLETE',explanation:'Market or spot-token metadata is incomplete or duplicated.'};
  const collateralToken=dex==='' && meta.collateralToken==null ? 0 : meta.collateralToken;
  if (!integer(collateralToken) || spot.tokens.filter(x=>x?.index===collateralToken && typeof x.name==='string').length!==1)
    return {ok:false,reasonCode:'COLLATERAL_UNRESOLVED',explanation:'The DEX collateral token cannot be resolved uniquely.'};
  return {ok:true,position,collateralToken,collateralName:spot.tokens.find(x=>x.index===collateralToken).name};
}

export function checkIntegration(evidence,{network,dex,coin,providedAssetId='',providedCollateral=''},now=Date.now()) {
  const base={kind:'LIVE DATA',network,market:coin,dex,source:ENDPOINTS[network]||'',apiStatus:200,fetchedAt:evidence?.finishedAt?new Date(evidence.finishedAt).toISOString():null,
    providedAssetId:String(providedAssetId).trim(),providedCollateral:String(providedCollateral).trim(),expectedAssetId:null,expectedCollateral:null};
  const result=(verdict,reasonCode,explanation)=>({...base,verdict,reasonCode,explanation});
  if (!evidence || evidence.network!==network || evidence.dex!==dex) return result('UNKNOWN','NETWORK_MISMATCH','Evidence does not match the selected network and DEX.');
  const valid=validateLiveEvidence(evidence,now);
  if (!valid.ok) return result('UNKNOWN',valid.reasonCode,valid.explanation);
  const matches=evidence.meta.universe.map((item,index)=>({item,index})).filter(({item})=>item.name===coin);
  if (matches.length!==1) return result('UNKNOWN','MARKET_NOT_FOUND','This market is absent from the selected DEX metadata.');
  const index=matches[0].index;
  if (index>=10_000) return result('UNKNOWN','ASSET_ID_UNSUPPORTED','The market index is outside the documented HIP-3 formula range.');
  base.expectedAssetId=valid.position===0?index:100000+valid.position*10000+index;
  base.expectedCollateral=valid.collateralName;
  base.collateralToken=valid.collateralToken;
  base.dexPosition=valid.position;
  if (base.providedAssetId && !/^\d+$/.test(base.providedAssetId)) return result('UNKNOWN','INPUT_INVALID','Expected asset ID must be a non-negative integer.');
  if (base.providedAssetId && !Number.isSafeInteger(Number(base.providedAssetId))) return result('UNKNOWN','INPUT_INVALID','Expected asset ID exceeds the safe integer range.');
  if (base.providedAssetId && Number(base.providedAssetId)!==base.expectedAssetId)
    return result('INVALID','ASSET_ID_MISMATCH','Your integration references an asset ID that does not match the selected market metadata.');
  if (base.providedCollateral && base.providedCollateral.toUpperCase()!==valid.collateralName.toUpperCase())
    return result('INVALID','COLLATERAL_MISMATCH','Your collateral assumption differs from the DEX collateral in public metadata.');
  if (!base.providedAssetId && !base.providedCollateral)
    return result('MARKET RESOLVED','NO_USER_EXPECTATION','Market metadata resolved. Enter an expected asset ID or collateral to check your integration.');
  return result('VALID','NONE','No issues detected against the metadata fetched for this check. This does not guarantee order acceptance.');
}

export class LiveClient {
  constructor(fetchImpl=(...args)=>fetch(...args),clock=()=>Date.now()) { this.fetchImpl=fetchImpl;this.clock=clock;this.cache=new Map();this.pending=new Map();this.controllers=new Set();this.epoch=0;this.lastRun=0; }
  clear(){this.epoch++;for(const controller of this.controllers)controller.abort();this.controllers.clear();this.cache.clear();this.pending.clear();}
  async post(network,body,{fresh=false}={}) {
    const endpoint=ENDPOINTS[network];if(!endpoint)throw new ApiFailure('NETWORK_MISMATCH','Unsupported network.');
    const key=network+':'+JSON.stringify(body),cached=this.cache.get(key);
    if(!fresh && cached && this.clock()-cached.at<LIVE_TTL_MS)return cached.data;
    if(this.pending.has(key))return this.pending.get(key);
    const epoch=this.epoch;
    const promise=(async()=>{const controller=new AbortController();this.controllers.add(controller);const timer=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT_MS);
      try {let response;
        for(let attempt=0;attempt<2;attempt++){
          response=await this.fetchImpl(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal,cache:'no-store'});
          if(response.ok || ![429,500,502,503,504].includes(response.status) || attempt===1)break;
          await new Promise(resolve=>setTimeout(resolve,response.status===429?1000:500));
        }
        if(!response.ok)throw new ApiFailure(response.status===429?'RATE_LIMITED':'API_HTTP_'+response.status,'Public API HTTP '+response.status+'.');
        const raw=await response.text();if(raw.length>4_000_000)throw new ApiFailure('RESPONSE_TOO_LARGE','API response exceeded the browser limit.');
        let data;try{data=JSON.parse(raw)}catch{throw new ApiFailure('MALFORMED_JSON','Public API returned malformed JSON.');}
        if(epoch===this.epoch)this.cache.set(key,{data,at:this.clock()});return data;
      }catch(error){if(error instanceof ApiFailure)throw error;throw new ApiFailure(error.name==='AbortError'?'TIMEOUT':'NETWORK_UNAVAILABLE',error.name==='AbortError'?'Public API timed out.':'Public API unavailable or blocked by browser: '+error.message);}
      finally{clearTimeout(timer);this.controllers.delete(controller);if(this.pending.get(key)===promise)this.pending.delete(key);}})();
    this.pending.set(key,promise);return promise;
  }
  async loadDexes(network){const registry=await this.post(network,{type:'perpDexs'});if(!Array.isArray(registry)||registry[0]!==null)throw new ApiFailure('SCHEMA_INCOMPLETE','Invalid DEX registry.');return registry;}
  async loadMarkets(network,dex){const meta=await this.post(network,{type:'meta',dex});if(!Array.isArray(meta?.universe))throw new ApiFailure('SCHEMA_INCOMPLETE','Invalid DEX metadata.');return meta.universe;}
  async capture(network,dex){
    if(this.clock()-this.lastRun<20_000)throw new ApiFailure('COOLDOWN','Wait 20 seconds between fresh checks.');
    this.lastRun=this.clock();const startedAt=this.clock();
    const registry=await this.post(network,{type:'perpDexs'},{fresh:true});
    const meta=await this.post(network,{type:'meta',dex},{fresh:true});
    const spot=await this.post(network,{type:'spotMeta'},{fresh:true});
    const registryAfter=await this.post(network,{type:'perpDexs'},{fresh:true});
    const metaAfter=await this.post(network,{type:'meta',dex},{fresh:true});
    const spotAfter=await this.post(network,{type:'spotMeta'},{fresh:true});
    return {network,dex,registry,meta,spot,registryAfter,metaAfter,spotAfter,startedAt,finishedAt:this.clock()};
  }
}
