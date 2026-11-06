// Placeholder GIF library. Real GIFs come from KLIPY or GIPHY once an API key
// is set (gif_api_key in config.json). The id is what gets saved in the sheet.
window.GIFS = [
  { id: 'party', label: 'Party blob', bg: '#EB5E28', ink: '#1A1917', tags: 'party yay celebrate done' },
  { id: 'thumbs', label: 'Thumbs up', bg: '#403D39', ink: '#FFFCF2', tags: 'ok yes good approve' },
  { id: 'clap', label: 'Slow clap', bg: '#6B665F', ink: '#FFFCF2', tags: 'clap bravo nice' },
  { id: 'mind', label: 'Mind blown', bg: '#F59A74', ink: '#1A1917', tags: 'wow amazing mind' },
  { id: 'fine', label: 'This is fine', bg: '#CCC5B9', ink: '#1A1917', tags: 'fine fire retake oops' },
  { id: 'chef', label: 'Chef’s kiss', bg: '#7A746B', ink: '#FFFCF2', tags: 'chef kiss perfect' },
  { id: 'fast', label: 'Gotta go fast', bg: '#EB5E28', ink: '#1A1917', tags: 'fast speed run bucky' },
  { id: 'melt', label: 'Melting', bg: '#A8A196', ink: '#1A1917', tags: 'melt tired hot goo' }
];
window.gifTile = function (id, attrs, cls) {
  const g = window.GIFS.find((x) => x.id === id);
  if (!g) return '';
  const tag = attrs ? 'button' : 'span';
  return '<' + tag + ' class="giftile ' + (cls || '') + '" ' + (attrs || '') + ' style="background:' + g.bg + ';color:' + g.ink + '">' +
    '<span class="badge">GIF</span><span class="blob" style="background:' + g.ink + '"></span><span class="t">' + g.label + '</span></' + tag + '>';
};
