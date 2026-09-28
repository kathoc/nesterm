export function demoEvents(frames=3000) {
  const events=[
    [180,'start',true],[184,'start',false],
    [360,'start',true],[364,'start',false],
    [1000,'right',true],[1020,'right',false],
    [1060,'up',true],[1090,'up',false],
    [1120,'a',true],[1124,'a',false],
    [1450,'right',true],[1450,'b',true],
  ];
  for(let f=1470;f<frames;f+=60) events.push([f,'a',true],[f+40,'a',false]);
  return events.sort((a,b)=>a[0]-b[0]);
}
