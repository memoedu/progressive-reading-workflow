import {createHash} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';

const HTML_MEDIA_LIMIT=512*1024*1024;
const MEDIA_SEPARATION_THRESHOLD=16*1024*1024;
const MEDIA_PREFIX=/(\b(?:src|href)\s*=\s*)(["']?)data:(?:image|audio|video)\/[a-z0-9.+-]+;base64,/iu;
const PREFIX_TAIL=128;

export async function readSiteResponse(response,maxBytes,{separateEmbeddedMedia=false}={}){
  const type=response.headers.get('content-type')||'';
  const canSeparate=separateEmbeddedMedia&&/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/iu.test(type);
  const chunks=[],html=[],hash=canSeparate?createHash('sha256'):null,decoder=new StringDecoder('utf8');
  let rawSize=0,textSize=0,buffer='',mediaEnd=null,separated=0,separating=false;
  const fail=reason=>Object.assign(new Error('站点响应超过完整读取上限'),
    {code:'site_response_size',reason,received_bytes:rawSize,retained_bytes:textSize,separated_inline_media:separated});
  const retain=text=>{
    if(!text)return;
    textSize+=Buffer.byteLength(text);
    if(textSize>maxBytes)throw fail('retained_html_limit');
    html.push(text);
  };
  const decode=(text,final=false)=>{
    buffer+=text;
    while(buffer){
      if(mediaEnd!==null){
        const close=mediaEnd?buffer.indexOf(mediaEnd):buffer.search(/[\s>]/u);
        if(/[<>]/u.test(close<0?buffer:buffer.slice(0,close)))throw fail('unsupported_inline_media');
        if(close<0){buffer='';break;}
        retain(mediaEnd||'"');
        buffer=buffer.slice(close+(mediaEnd?1:0));
        mediaEnd=null;
      }
      const media=MEDIA_PREFIX.exec(buffer);
      if(!media){
        const boundary=final?buffer.length:Math.max(0,buffer.length-PREFIX_TAIL);
        retain(buffer.slice(0,boundary));
        buffer=buffer.slice(boundary);
        return;
      }
      retain(buffer.slice(0,media.index)+'data-pr-separated-media="" '+media[1]+(media[2]||'"'));
      mediaEnd=media[2];
      separated++;
      buffer=buffer.slice(media.index+media[0].length);
    }
  };
  for await(const chunk of response.body){
    rawSize+=chunk.length;
    hash?.update(chunk);
    if(!canSeparate&&rawSize>maxBytes)throw fail('response_limit');
    if(canSeparate&&rawSize>Math.min(maxBytes,MEDIA_SEPARATION_THRESHOLD)&&!separating){
      separating=true;
      for(const prefix of chunks)decode(decoder.write(prefix));
      chunks.length=0;
    }
    if(separating){
      if(rawSize>HTML_MEDIA_LIMIT)throw fail('archived_response_limit');
      decode(decoder.write(chunk));
    }else chunks.push(chunk);
  }
  if(separating){
    decode(decoder.end(),true);
    if(mediaEnd!==null)throw fail('unterminated_inline_media');
    return {body:html.join(''),sha256:hash.digest('hex'),bytes:rawSize,
      ...(separated?{separated_inline_media:separated}:{})};
  }
  const body=Buffer.concat(chunks).toString('utf8');
  return {body,sha256:createHash('sha256').update(body).digest('hex'),bytes:rawSize};
}
