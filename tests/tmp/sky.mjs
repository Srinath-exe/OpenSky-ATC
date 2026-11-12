const RAY=[5.804542996261093E-6,1.3562911419845635E-5,3.0265902468824876E-5],MIE=[1.8399918514433978E14,2.7798023919660528E14,4.0790479543861094E14];
const aces=x=>Math.min(1,Math.max(0,(x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14)));
function sc(dir,sd,turb,ray,mieC,g,exp){const sunE=1000*Math.max(0,1-Math.exp(-((1.6110731556870734-Math.acos(sd[1]))/1.5)));const sunfade=1-Math.min(1,Math.max(0,1-Math.exp(sd[1])));
const za=Math.acos(Math.max(0,dir[1]));const inv=1/(Math.cos(za)+0.15*Math.pow(93.885-za*180/Math.PI,-1.253));const ct=dir[0]*sd[0]+dir[1]*sd[1]+dir[2]*sd[2];
const rPh=0.0597*(1+Math.pow(ct*0.5+0.5,2));const g2=g*g;const mPh=0.0796*(1-g2)/Math.pow(1-2*g*ct+g2,1.5);const k=Math.min(1,Math.pow(1-sd[1],5));
return [0,1,2].map(i=>{const bR=RAY[i]*(ray-(1-sunfade)),bM=0.434*(0.2*turb)*10E-18*MIE[i]*mieC;const fex=Math.exp(-(bR*8.4E3+bM*1.25E3)*inv);const bT=(bR*rPh+bM*mPh)/(bR+bM);
let Lin=Math.pow(sunE*bT*(1-fex),1.5);Lin*=1+(Math.pow(sunE*bT*fex,0.5)-1)*k;const t=(Lin+0.1*fex)*0.04+[0,0.0003,0.00075][i];const raw=Math.pow(t,1/(1.2+1.2*sunfade));return [raw.toFixed(3),aces(raw*exp).toFixed(3)]})}
const el=38*Math.PI/180, az=150*Math.PI/180; const sd=[Math.sin(az)*Math.cos(el),Math.sin(el),-Math.cos(az)*Math.cos(el)];
for (const y of [0.03,0.1,0.25,0.6]) { const yaw=1.45; const d=[-Math.sin(yaw),y,-Math.cos(yaw)]; const n=Math.hypot(...d); console.log(y, JSON.stringify(sc(d.map(v=>v/n),sd,1.9,2.4,0.005,0.8,0.52))); }
const srgb=v=>Math.round(255*(v<=0.0031308?v*12.92:1.055*Math.pow(v,1/2.4)-0.055));
for (const [ray,ex,el0] of [[3,0.5,38],[3,0.7,1.5],[2.4,0.5,38]]) { const el=el0*Math.PI/180; const sd=[Math.sin(az)*Math.cos(el),Math.sin(el),-Math.cos(az)*Math.cos(el)];
 for (const y of [0.03,0.25,0.6]) { const yaw=1.45; const d=[-Math.sin(yaw),y,-Math.cos(yaw)]; const n=Math.hypot(...d); const raw=sc(d.map(v=>v/n),sd,1.9,ray,0.005,0.8,1).map(a=>+a[0]*ex); const L=0.2126*raw[0]+0.7152*raw[1]+0.0722*raw[2]; const o=raw.map(v=>Math.min(1,v/(1+L)*1.4)); const l2=0.2126*o[0]+0.7152*o[1]+0.0722*o[2]; const s=o.map(v=>Math.max(0,l2+(v-l2)*1.2)); console.log(ray,ex,el0,y,s.map(srgb).join(',')); } }
