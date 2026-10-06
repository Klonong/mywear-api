import { sniffImage } from './uploads.controller';

const pad = (head: Buffer) => Buffer.concat([head, Buffer.alloc(16)]);

describe('sniffImage', () => {
  it('recognises the allowed formats by their bytes', () => {
    expect(sniffImage(pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0])))?.ext).toBe(
      'jpg',
    );
    expect(sniffImage(pad(Buffer.from('89504e470d0a1a0a', 'hex')))?.ext).toBe(
      'png',
    );
    expect(sniffImage(pad(Buffer.from('RIFF\0\0\0\0WEBP')))?.ext).toBe('webp');
    expect(sniffImage(pad(Buffer.from('\0\0\0\x1cftypavif')))?.ext).toBe(
      'avif',
    );
  });

  it('rejects SVG, HTML and short input whatever the client claims', () => {
    expect(
      sniffImage(pad(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'))),
    ).toBeNull();
    expect(sniffImage(pad(Buffer.from('<!doctype html><script>')))).toBeNull();
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });
});
