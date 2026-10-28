import {readFile,writeFile,mkdir} from 'node:fs/promises';
import sharp from 'sharp';
import {inspectPhoto} from '../utils/catalogMedia.js';
const root=new URL('../catalog/',import.meta.url);
const refs=JSON.parse(await readFile(new URL('reference-galleries.json',root)));
const sources=JSON.parse(await readFile(new URL('remaining-photo-sources.json',root)));
const multi={P18:'Fastily apartment 28 September 2018, consecutive exposure times and matching finishes',P19:'Riverside Plaza apartment 26 August 2014, same documented apartment and photo outing',P25:'Victor Grigas Wrightwood apartment 17 August 2015, matching interiors and source captions',P28:'Michael Barera Pritzlaff apartment interior 27 September 2025, same apartment, GPS and finishes'};
const chosen=sources.filter(s=>s.key!=='M26' && (s.key!=='P21'||s.index===0));
for(const key of [...new Set(chosen.map(s=>s.key))]) {
 if(refs[key]) throw new Error('Refusing to replace existing reviewed gallery '+key);
 const media=[],previewGallery=[];
 for(const [i,s] of chosen.filter(s=>s.key===key).entries()) {
  const bytes=await readFile(new URL('remaining-photo-review/'+s.reviewFile,root));
  const {evidence}=await inspectPhoto(s.downloadUrl,{decoder:sharp,fetcher:async()=>new Response(bytes,{status:200})});
  const text=x=>String(x||'').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').trim();
  const meta=s.extmetadata,author=text(meta.Artist?.value),license=text(meta.LicenseShortName?.value),licenseUrl=text(meta.LicenseUrl?.value).replace(/^http:/,'https:');
  if(!author||!licenseUrl)throw new Error('Missing rights '+key);
  const property=key.startsWith('P'),angle=property?(multi[key]?['living area','interior reverse angle','kitchen or adjoining interior'][i]:'reference living room'):'reference model view';
  const identity=multi[key]||s.title;
  const extension=evidence.format==='jpeg'?'jpg':evidence.format;
  const url=`/catalog-media/${key}/reference-${i+1}.${extension}`;
  const local=new URL('../../public'+url,import.meta.url);
  await mkdir(new URL('./',local),{recursive:true}); await writeFile(local,bytes);
  media.push({url:s.downloadUrl,sourcePage:s.descriptionurl,author,license,licenseUrl,
   attribution:`${s.title.replace(/^File:/,'')} — ${author}, ${license}. Wikimedia reference photograph; resized where supplied by Commons, no further alterations. Reference Photos — Demo/Sample Listing. Not the listed Mumbai inventory; specifications unverified.`,
   licenseEvidence:`remaining-photo-sources.json: ${s.title}, explicit source license metadata`,rightsReviewedBy:'Codex — source copyright/attribution review',rightsApproved:true,kind:'photograph',matchApproved:true,matchReviewedBy:'Codex — decoded photograph and reference identity review',
   identityEvidence:`${identity}. ${property?'All views in this gallery document this same reference home, not the fictional Mumbai address or its verified furnishing/layout.':'Correct make/model reference only; physical rental vehicle and exact variant specifications unverified.'}`,
   depictedCatalogKey:`mumbai-2026-${key}`,setId:identity,angle,qualityApproved:true,qualityReviewedBy:'Codex — visual framing and decoded image review',...evidence,checkedAt:s.checkedAt,localFile:'../public'+url,sourceLocation:text(meta.ImageDescription?.value)});
  previewGallery.push({url,kind:'photograph',label:`${angle} — Reference Photos — Demo/Sample Listing`,sha256:evidence.sha256});
 }
 refs[key]={media,previewGallery};
 await writeFile(new URL(`../../public/catalog-media/${key}/ATTRIBUTION.md`,import.meta.url),media.map(p=>`${p.attribution}\nSource: ${p.sourcePage}\nLicense: ${p.licenseUrl}\nIdentity: ${p.identityEvidence}\n`).join('\n'));
}
await writeFile(new URL('reference-galleries.json',root),JSON.stringify(refs,null,2)+'\n');
console.log('New photographs:',chosen.length,'; M26 excluded (wrong older model).');
