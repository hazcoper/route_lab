'use strict';
const $ = id => document.getElementById(id);
let map, routeLayers, charts = [], timeCharts = [], currentTrip, hoverMarker;
let syncingZoom = false;
let mapResizeObserver = null;
let mapResizeFrame = null;
const fmt = n => Number(n).toLocaleString(undefined, {maximumFractionDigits: 1});
const when = s => new Date(s).toLocaleString(undefined, {dateStyle:'medium', timeStyle:'short'});
const duration = secs => {const h=Math.floor(secs/3600),m=Math.floor((secs%3600)/60);return `${h}h ${String(m).padStart(2,'0')}m`;};
const escapeText = s => String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function error(message){$('errorBox').textContent=message;$('errorBox').classList.add('show')}
async function loadPublishedTrip() {
  $('errorBox').classList.remove('show');
  try {
    const response=await fetch('./data/trip.json', {cache:'no-cache'});
    if(!response.ok)throw new Error('No published trip found. Run tools/publish_trip.py and commit data/trip.json.');
    const data=await response.json();
    if(!data.points || !data.points.length)throw new Error('Trip has no GPS points.');
    currentTrip=data;
    render(data);
  } catch(err) { error('Unable to load published trip: '+err.message); }
}
$('newTrip').addEventListener('click',()=>window.location.reload());
loadPublishedTrip();

function render(data){
  $('uploadScreen').classList.add('hidden');$('dashboard').classList.remove('hidden');$('newTrip').classList.remove('hidden');
  const s=data.stats, pts=data.points;
  $('tripDates').textContent=`${when(s.start)} — ${when(s.end)} · ${fmt(s.points)} GPS samples`;
  [['exportCSV','csv'],['exportGPX','gpx'],['exportKML','kml']].forEach(([id,ext])=>$(id).href=`./data/trip.${ext}`);
  const cards=[
    ['Covered distance',fmt(s.distanceKm),'km','Straight-line segments · gaps excluded'],
    ['Mean GPS speed',fmt(s.averageSpeedKmh),'km/h','Arithmetic mean of recorded speeds'],
    ['Max GPS speed',fmt(s.maxSpeedKmh),'km/h','Highest reported sample'],
    ['Elapsed trip time',duration(s.durationSeconds),'','First to last GPS point'],
    ['GPS records',fmt(s.points),'points',`${fmt(s.expectedIntervalSeconds)}s typical interval`],
  ];
  $('stats').innerHTML=cards.map(([label,value,unit,note])=>`<div class="stat-card"><div class="metric-label">${label}</div><div class="metric-value">${value} <span class="metric-unit">${unit}</span></div><div class="metric-note">${note}</div></div>`).join('');
  const warnings=[];
  if(s.gaps)warnings.push(`${s.gaps} recording gaps longer than ${fmt(s.gapThresholdSeconds)} seconds were detected. Route sections are disconnected across gaps; distance is a lower bound and may omit travel.`);
  if(s.invalidPoints)warnings.push(`${s.invalidPoints} invalid points were excluded.`);
  if(s.trailingBytes)warnings.push(`${s.trailingBytes} incomplete bytes at the end of the file were ignored.`);
  if(!warnings.length)warnings.push('Distance is the sum of straight-line distances between samples, not road-matched mileage. Mean GPS speed is a sample average, not total distance ÷ elapsed time.');
  $('notice').textContent=warnings.join('  ');$('notice').classList.remove('hidden');
  const details=[
['Connected-segment sum',`${fmt(s.distanceKm)} km`],['Start time',when(s.start)],['End time',when(s.end)],['Mean moving sample speed',`${fmt(s.movingSpeedKmh)} km/h`],
    ['Median sample speed',`${fmt(s.medianSpeedKmh)} km/h`],['Full-trip distance ÷ elapsed',`${fmt(s.overallLowerBoundKmh)} km/h`],
    ['Distance ÷ covered time',`${fmt(s.connectedAverageKmh)} km/h`],['Estimated moving time (covered segments)',duration(s.movingSecondsEstimate)],
    ['Estimated stopped time (covered segments)',duration(s.stoppedSecondsEstimate)],['Satellite count (average)',fmt(s.satMean)],
    ['Gaps over threshold',fmt(s.gaps)],['Typical sample interval',`${fmt(s.expectedIntervalSeconds)} seconds`],['Complete records',fmt(s.points)]
  ];
  $('details').innerHTML=details.map(([a,b])=>`<div class="detail"><label>${escapeText(a)}</label><strong>${escapeText(b)}</strong></div>`).join('');
  drawMap(data);drawCharts(data);
}
function speedColor(speed){if(speed<20)return '#1768FF';if(speed<50)return '#00B6FF';if(speed<80)return '#7A4DFF';if(speed<105)return '#EC3FBF';return '#FA4356'}
function drawMap(data){
  if(typeof L==='undefined'){ $('map').textContent='Map library unavailable: connect to the internet to load Leaflet.';return}
  // Diagnostic for deployments where an external Leaflet stylesheet failed to load.
  const leafletStylesLoaded = Array.from(document.styleSheets).some(sheet =>
    (sheet.href || '').includes('leaflet')
  );
  if (!leafletStylesLoaded) {
    console.warn('External Leaflet CSS not detected; using RouteLab built-in Leaflet layout fallback.');
  }
  map=L.map('map',{preferCanvas:true});
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);
  routeLayers=L.featureGroup().addTo(map);
  const pts=data.points;
  for(const seg of data.segments){
    for(let j=1;j<seg.length;j++){
      const a=pts[seg[j-1]],b=pts[seg[j]];
      L.polyline([[a.lat,a.lon],[b.lat,b.lon]],{color:speedColor((a.speed+b.speed)/2),weight:5,opacity:.9})
        .bindPopup(`<b>${escapeText(when(b.time))}</b><br>Speed: ${fmt(b.speed)} km/h<br>Satellites: ${b.sat}<br>Fix: ${escapeText(b.fixName)}`)
        .addTo(routeLayers);
    }
  }
  const marker=(p,title,color)=>L.circleMarker([p.lat,p.lon],{radius:9,color:'#fff',weight:2,fillColor:color,fillOpacity:1}).bindPopup(`<b>${title}</b><br>${escapeText(when(p.time))}`).addTo(routeLayers);
  marker(pts[0],'Start','#36c7a1');marker(pts[pts.length-1],'End','#f78d70');
  hoverMarker=L.circleMarker([pts[0].lat,pts[0].lon],{radius:10,color:'#ffffff',weight:3,fillColor:'#57b8ff',fillOpacity:.9,interactive:false});
  function fit(){const b=routeLayers.getBounds();if(b.isValid())map.fitBounds(b.pad(.1),{maxZoom:15})}
  // Leaflet must recalculate after the dashboard becomes visible and whenever
  // responsive layout or panel size changes. A single 75 ms timeout is unreliable.
  const resizeMap = () => {
    if (!map) return;
    if (mapResizeFrame) cancelAnimationFrame(mapResizeFrame);
    mapResizeFrame = requestAnimationFrame(() => {
      if (!map) return;
      map.invalidateSize({pan:false, debounceMoveend:true});
      mapResizeFrame = null;
    });
  };
  $('fitMap').onclick=()=>{resizeMap();fit();};
  mapResizeObserver = new ResizeObserver(resizeMap);
  mapResizeObserver.observe($('map'));
  window.addEventListener('resize', resizeMap);
  // Fit after the element is visible and has gone through layout/paint.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    resizeMap();
    fit();
    setTimeout(resizeMap, 250);
    setTimeout(resizeMap, 1000);
  }));
}
function findClosestIndex(pts, timestampMs) {
  let lo=0,hi=pts.length-1;
  while(lo<hi){const mid=Math.floor((lo+hi)/2);if(pts[mid].ts*1000<timestampMs)lo=mid+1;else hi=mid;}
  if(lo>0 && Math.abs(pts[lo-1].ts*1000-timestampMs)<Math.abs(pts[lo].ts*1000-timestampMs)) return lo-1;
  return lo;
}
function synchronizeZoom(source) {
  if(syncingZoom) return;
  syncingZoom=true;
  const {min,max}=source.scales.x;
  for(const chart of timeCharts){
    if(chart===source)continue;
    chart.options.scales.x.min=min;
    chart.options.scales.x.max=max;
    chart.update('none');
  }
  syncingZoom=false;
}
function drawCharts(data){
  if(typeof Chart==='undefined')return;
  const pts=data.points;
  Chart.defaults.color='#97aabb';Chart.defaults.borderColor='rgba(105,130,148,.16)';
  const gap=data.stats.gapThresholdSeconds*1000;
  function series(key){
    const arr=[];let prev=null;
    pts.forEach(p=>{const x=p.ts*1000;
      if(prev!==null && (x-prev>gap || x<=prev))arr.push({x:x-1,y:null});
      arr.push({x,y:p[key]});prev=x;});
    return arr;
  }
  const cursorPlugin={id:'linkedCursor',afterDraw(chart){
    if(window.routeLabHoverX===undefined || !timeCharts.includes(chart))return;
    const x=chart.scales.x.getPixelForValue(window.routeLabHoverX);
    const a=chart.chartArea;
    if(x<a.left||x>a.right)return;
    const ctx=chart.ctx;ctx.save();ctx.beginPath();ctx.moveTo(x,a.top);ctx.lineTo(x,a.bottom);ctx.lineWidth=1;ctx.strokeStyle='#f5f7fa99';ctx.setLineDash([5,4]);ctx.stroke();ctx.restore();
  }};
  // Register locally to avoid duplicate registration when another file is loaded.
  Chart.register(cursorPlugin);
  const base={
    responsive:true, maintainAspectRatio:false, parsing:false, animation:false,
    interaction:{mode:'nearest',axis:'x',intersect:false},
    onHover:(event,_elements,chart)=>{
      const xValue=chart.scales.x.getValueForPixel(event.x);
      if(!Number.isFinite(xValue))return;
      const idx=findClosestIndex(pts,xValue);
      window.routeLabHoverX=pts[idx].ts*1000;
      if(map && hoverMarker){hoverMarker.setLatLng([pts[idx].lat,pts[idx].lon]);if(!map.hasLayer(hoverMarker))hoverMarker.addTo(map);}
      for(const linked of timeCharts) linked.draw();
    },
    plugins:{legend:{display:false},zoom:{
      limits:{x:{min:pts[0].ts*1000,max:pts[pts.length-1].ts*1000}},
      zoom:{wheel:{enabled:true,speed:.08},pinch:{enabled:true},drag:{enabled:true,backgroundColor:'rgba(105,228,198,.12)',borderColor:'#69e4c6',borderWidth:1},mode:'x',onZoomComplete:({chart})=>synchronizeZoom(chart)},
      pan:{enabled:true,mode:'x',onPanComplete:({chart})=>synchronizeZoom(chart)}
    }},
    scales:{x:{type:'time',time:{tooltipFormat:'MMM d, HH:mm:ss'},grid:{display:false},ticks:{maxTicksLimit:7}},y:{beginAtZero:true,grid:{color:'rgba(105,130,148,.12)'}}}
  };
  function plot(id,label,values,color,{fill=false,zero=true}={}){
    const options=JSON.parse(JSON.stringify(base));
    options.scales.y.beginAtZero=zero;
    options.onHover=base.onHover;
    options.plugins.zoom.zoom.onZoomComplete=base.plugins.zoom.zoom.onZoomComplete;
    options.plugins.zoom.pan.onPanComplete=base.plugins.zoom.pan.onPanComplete;
    const chart=new Chart($(id),{type:'line',data:{datasets:[{label,data:values,borderColor:color,backgroundColor:fill?'rgba(105,228,198,.10)':'transparent',fill,tension:.12,pointRadius:0,pointHoverRadius:5,borderWidth:2,spanGaps:false}]},options});
    charts.push(chart);timeCharts.push(chart);
  }
  plot('speedChart','Speed (km/h)',series('speed'),'#69e4c6',{fill:true});
  plot('satChart','Satellites',series('sat'),'#7eaefe');
  plot('distanceChart','Covered distance (km)',series('connectedDistanceKm'),'#9A85FF');
  $('resetZoom').onclick=()=>{
    syncingZoom=true;
    timeCharts.forEach(chart=>{chart.options.scales.x.min=undefined;chart.options.scales.x.max=undefined;chart.resetZoom('none');chart.update('none');});
    syncingZoom=false;
  };
  const counts=Object.entries(data.stats.fixCounts);
  charts.push(new Chart($('fixChart'),{type:'doughnut',data:{labels:counts.map(x=>x[0]),datasets:[{data:counts.map(x=>x[1]),backgroundColor:['#69e4c6','#7eaefe','#e9c76c','#bd8cff','#ef8b75','#9cc8d4'],borderWidth:0,spacing:3}]},options:{responsive:true,maintainAspectRatio:false,cutout:'68%',plugins:{legend:{display:true,position:'right',labels:{color:'#b7c8d4',boxWidth:12,padding:16}}}}}));
}
