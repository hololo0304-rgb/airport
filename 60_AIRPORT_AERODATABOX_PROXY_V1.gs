/**
 * File: 60_AIRPORT_AERODATABOX_PROXY_V1.gs
 * Version: AIRPORT_AERODATABOX_PROXY_V1_20261012
 * Purpose: Separate, quota-capped AeroDataBox RapidAPI GET proxy for a private hobby flight board.
 * SAFETY: No key in source / no Gmail, Drive, CardHub, payment or scheduled triggers.
 *
 * Setup in a NEW standalone Apps Script project (NOT the CardHub receiver):
 * Project Settings -> Script properties:
 *   AERODATABOX_RAPIDAPI_KEY = (your private RapidAPI key)
 * Run: run_01_preflight (NO external API calls)
 * Optional real single call: run_02_testOneHND (USES 2 RapidAPI units)
 * Deploy -> Web app -> Execute as Me -> Anyone.
 *
 * NOTE: Anyone can invoke a public Web App; this cannot prove the browser's owner.
 * The strict server-side daily/monthly call caps reduce financial/usage exposure,
 * but do not authenticate visitors. Use a truly authenticated backend for private access.
 */

var AIRPORT_AERO_V1 = {
  VERSION: 'AIRPORT_AERODATABOX_PROXY_V1_20261012',
  HOST: 'aerodatabox.p.rapidapi.com',
  URL: 'https://aerodatabox.p.rapidapi.com/flights/airports/iata/',
  PROPERTY_KEY: 'AERODATABOX_RAPIDAPI_KEY',
  DAY_LIMIT: 2,
  MONTH_LIMIT: 70,
  DURATION_MINUTES: 720,
  PROPERTY_PART_LENGTH: 7000,
  MAX_CHUNKS_PER_SNAPSHOT: 32,
  STORE_PREFIX: 'AIRPORT_AERO_V1_'
};

function run_01_preflight() {
  var p = PropertiesService.getScriptProperties();
  var key = p.getProperty(AIRPORT_AERO_V1.PROPERTY_KEY) || '';
  var result = {
    ok: true,
    version: AIRPORT_AERO_V1.VERSION,
    rapidapi_key_configured: key.length > 12,
    key_exposed: false,
    daily_request_limit: AIRPORT_AERO_V1.DAY_LIMIT,
    monthly_request_limit: AIRPORT_AERO_V1.MONTH_LIMIT,
    maximum_minutes_per_request: AIRPORT_AERO_V1.DURATION_MINUTES,
    external_calls: 0,
    writes: 0,
    next: key.length > 12 ? 'READY_FOR_ONE_MANUAL_TEST' : 'ADD_SCRIPT_PROPERTY'
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function run_02_testOneHND() {
  // EXTERNAL EFFECT: this is a real, quota-consuming flight API call.
  // Counted toward the same 2/day, 70/month safety limit as the Web app.
  var result = getFlightsSnapshot_V1_('HND');
  // Never log API keys or detailed passenger/flight payloads.
  console.log(JSON.stringify({
    ok: result.ok,
    status: result.status,
    airport: result.airport,
    flight_count: (result.flights || []).length,
    quota: result.quota || null
  }, null, 2));
  return {ok:result.ok,status:result.status,airport:result.airport,flightCount:(result.flights||[]).length};
}

function doGet(e) {
  var q = e && e.parameter ? e.parameter : {};
  var out;
  try {
    if (q.action === 'health') {
      out = {ok:true,version:AIRPORT_AERO_V1.VERSION,mode:'HEALTH',key_exposed:false,external_calls:0};
    } else if (q.action === 'flights' && /^[A-Z]{3}$/.test(String(q.airport || '').toUpperCase())) {
      out = getFlightsSnapshot_V1_(String(q.airport).toUpperCase());
    } else {
      out = {ok:false,status:'INVALID_REQUEST',message:'Use ?action=health or ?action=flights&airport=HND'};
    }
  } catch (error) {
    // Avoid returning internal credentials, provider payloads, headers or stack traces.
    console.warn('Aero proxy error (redacted): '+String(error && error.name || 'error'));
    out = {ok:false,status:'SERVER_ERROR',message:'Temporary backend error; no key was exposed'};
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function getFlightsSnapshot_V1_(airport) {
  if (!/^[A-Z]{3}$/.test(airport))return {ok:false,status:'INVALID_AIRPORT'};
  var config = AIRPORT_AERO_V1;
  var now = new Date();
  var day = Utilities.formatDate(now,'Asia/Taipei','yyyyMMdd');
  var month = Utilities.formatDate(now,'Asia/Taipei','yyyyMM');
  var dailyKey = config.STORE_PREFIX+'D_'+day;
  var monthlyKey = config.STORE_PREFIX+'M_'+month;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000))return {ok:false,status:'SERVER_BUSY',message:'Please retry later'};
  try {
    var p = PropertiesService.getScriptProperties();
    var slots = JSON.parse(p.getProperty(dailyKey) || '[]');
    var prior = slots.filter(function(x){return x.airport === airport;})[0];
    if (prior) {
      if (prior.state === 'ok') {
        var cached = readSnapshot_V1_(p,day,airport);
        if (cached)return cached;
        return {ok:false,status:'CACHE_MISSING',airport:airport,message:'Today was already fetched; no automatic extra API usage'};
      }
      return {ok:false,status:'ALREADY_ATTEMPTED',airport:airport,message:'Today already attempted this airport; no automatic retry'};
    }
    var usedMonth = Number(p.getProperty(monthlyKey) || 0);
    if (slots.length >= config.DAY_LIMIT)
      return {ok:false,status:'DAILY_LIMIT',message:'Two airport requests already used for today'};
    if (usedMonth >= config.MONTH_LIMIT)
      return {ok:false,status:'MONTHLY_LIMIT',message:'Monthly safety limit reached'};
    var rapidKey = p.getProperty(config.PROPERTY_KEY);
    if (!rapidKey || rapidKey.length < 12)
      return {ok:false,status:'KEY_NOT_CONFIGURED',message:'Set AERODATABOX_RAPIDAPI_KEY in Script Properties'};
    // Reserve the budget BEFORE requesting external data to fail closed on errors.
    slots.push({airport:airport,state:'attempt',at:now.toISOString()});
    p.setProperty(dailyKey,JSON.stringify(slots));
    p.setProperty(monthlyKey,String(usedMonth+1));

    var query='?offsetMinutes=0&durationMinutes=720&direction=Departure'+
      '&withLeg=true&withCancelled=true&withCodeshared=false'+
      '&withCargo=false&withPrivate=false&withLocation=false';
    var url=config.URL+encodeURIComponent(airport)+query;
    var http;
    try {
      http=UrlFetchApp.fetch(url,{
        method:'get',
        headers:{
          'X-RapidAPI-Host':config.HOST,
          'X-RapidAPI-Key':rapidKey,
          'Accept':'application/json'
        },
        muteHttpExceptions:true,
        followRedirects:true
      });
    } catch (externalError) {
      return {ok:false,status:'UPSTREAM_NETWORK_ERROR',airport:airport,message:'Request failed; quota attempt recorded'};
    }
    var httpStatus = http.getResponseCode();
    if (httpStatus !== 200)
      return {ok:false,status:'UPSTREAM_HTTP_'+httpStatus,airport:airport,message:'Provider returned an error; quota attempt recorded'};
    var body;
    try {body=JSON.parse(http.getContentText());}
    catch (parseError){return {ok:false,status:'UPSTREAM_INVALID_JSON',airport:airport};}
    if (!body || !Array.isArray(body.departures))
      return {ok:false,status:'UPSTREAM_NO_DEPARTURES_ARRAY',airport:airport};

    var flights = normalizeFlights_V1_(body.departures);
    var value = {
      ok:true,status:'SUCCESS',airport:airport,source:'AeroDataBox via RapidAPI',
      fetchedAt:now.toISOString(),startMs:now.getTime(),
      endMs:now.getTime()+config.DURATION_MINUTES*60000,
      flights:flights,
      flightCount:flights.length,
      notice:'One saved 12-hour snapshot, not a live-updating board',
      attribution:'Flight data powered by AeroDataBox',
      quota:{todayUsed:slots.length,todayMax:config.DAY_LIMIT,monthUsed:usedMonth+1,monthMax:config.MONTH_LIMIT}
    };
    if (!saveSnapshot_V1_(p,day,airport,value))
      return {ok:false,status:'SNAPSHOT_STORAGE_LIMIT',airport:airport,message:'The API was used but snapshot was too large to store; will not retry automatically'};

    slots[slots.length-1].state='ok';
    p.setProperty(dailyKey,JSON.stringify(slots));
    cleanupOldAeroProperties_V1_(p,day);
    return value;
  } finally {
    lock.releaseLock();
  }
}

function normalizeFlights_V1_(departures) {
  var result = [], unique = {};
  departures.forEach(function(f){
    if (!f || typeof f !== 'object')return;
    var departure=f.departure || f.movement || {};
    var arrival=f.arrival || {};
    var destination=arrival.airport || (f.movement ? f.movement.airport : null) || {};
    var scheduled=departure.scheduledTime || {};
    var actual=departure.actualTime || {};
    var scheduledUtc=String(scheduled.utc || '');
    var timeMs=Date.parse(scheduledUtc);
    if (!Number.isFinite(timeMs))return; // do not invent local-to-UTC conversion
    var flight=String(f.number || f.callSign || '').trim();
    if (!flight)return;
    var destCode=String(destination.iata || '').trim().toUpperCase();
    var destName=String(destination.name || destCode || '');
    var status=String(f.status || '');
    var key=flight+'|'+timeMs+'|'+destCode;
    if(unique[key])return;
    unique[key]=1;
    result.push({
      code:flight,timeMs:timeMs,destCode:destCode,destName:destName,
      localTime:String(scheduled.local || ''),
      status:status,
      actualTimeUtc:String(actual.utc || '')
    });
  });
  result.sort(function(a,b){return a.timeMs-b.timeMs || a.code.localeCompare(b.code);});
  return result;
}

function snapshotPrefix_V1_(day,airport) {
  return AIRPORT_AERO_V1.STORE_PREFIX+'S_'+day+'_'+airport+'_';
}
function saveSnapshot_V1_(p,day,airport,value) {
  var payload=JSON.stringify(value);
  var blob=Utilities.gzip(Utilities.newBlob(payload,'application/json'));
  var packed=Utilities.base64Encode(blob.getBytes());
  var size=AIRPORT_AERO_V1.PROPERTY_PART_LENGTH;
  var count=Math.ceil(packed.length/size);
  if(count<1 || count>AIRPORT_AERO_V1.MAX_CHUNKS_PER_SNAPSHOT)return false;
  var prefix=snapshotPrefix_V1_(day,airport);
  var data={};
  for(var i=0;i<count;i++)data[prefix+i]=packed.slice(i*size,(i+1)*size);
  data[prefix+'count']=String(count);
  p.setProperties(data,false);
  return true;
}
function readSnapshot_V1_(p,day,airport) {
  var prefix=snapshotPrefix_V1_(day,airport);
  var count=Number(p.getProperty(prefix+'count')||0);
  if(!count||count>AIRPORT_AERO_V1.MAX_CHUNKS_PER_SNAPSHOT)return null;
  var packed='';
  for(var i=0;i<count;i++){
    var part=p.getProperty(prefix+i);
    if(!part)return null;
    packed+=part;
  }
  try {
    var bytes=Utilities.base64Decode(packed);
    var json=Utilities.ungzip(Utilities.newBlob(bytes)).getDataAsString('UTF-8');
    return JSON.parse(json);
  }catch(e){return null;}
}
function cleanupOldAeroProperties_V1_(p,day) {
  // Max seven-day retention, leave the stored API key untouched.
  var all=p.getProperties();
  var today=Date.UTC(+day.slice(0,4),+day.slice(4,6)-1,+day.slice(6));
  Object.keys(all).forEach(function(k){
    var match=k.match(/^AIRPORT_AERO_V1_(?:D_|S_)(\d{8})(?:_|$)/);
    if(!match)return;
    var d=match[1];
    var age=today-Date.UTC(+d.slice(0,4),+d.slice(4,6)-1,+d.slice(6));
    if(age>7*86400000)p.deleteProperty(k);
  });
}
