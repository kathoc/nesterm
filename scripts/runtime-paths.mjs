import {existsSync} from 'node:fs';

export function optionValue(args, name) {
  const index=args.indexOf(name);
  if(index<0)return undefined;
  const value=args[index+1];
  if(!value || value.startsWith('--'))throw new Error(`${name} requires a path`);
  return value;
}

export function requireRomPath(args=process.argv.slice(2)) {
  const path=optionValue(args,'--rom') || process.env.NESTERM_ROM;
  if(!path)throw new Error('ROM path required: pass --rom /path/to/game.nes or set NESTERM_ROM');
  return path;
}

export function positionalArgs(args, valuedOptions=['--rom']) {
  const values=[];
  for(let index=0;index<args.length;index++) {
    if(valuedOptions.includes(args[index])) {
      optionValue(args,args[index]);index++;
    } else values.push(args[index]);
  }
  return values;
}

export function findMonoFont(explicit=process.env.NESTERM_FONT) {
  if(explicit) {
    if(!existsSync(explicit))throw new Error(`NESTERM_FONT does not exist: ${explicit}`);
    return explicit;
  }
  const candidates=[
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
    '/usr/share/fonts/dejavu/DejaVuSansMono.ttf',
    '/System/Library/Fonts/SFNSMono.ttf',
    '/System/Library/Fonts/Menlo.ttc',
    '/System/Library/Fonts/Monaco.ttf',
    '/System/Library/Fonts/Supplemental/Andale Mono.ttf',
    '/Library/Fonts/Andale Mono.ttf',
  ];
  const found=candidates.find(existsSync);
  if(!found)throw new Error('No supported monospace font found; set NESTERM_FONT to a font file');
  return found;
}
