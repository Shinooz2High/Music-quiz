const fs = require('fs');
const path = require('path');

function createWav(notes, durationPerNote, sampleRate = 22050) {
  const totalSamples = Math.floor(notes.length * durationPerNote * sampleRate);
  const buffer = Buffer.alloc(44 + totalSamples * 2);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + totalSamples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // subchunk1 size
  buffer.writeUInt16LE(1, 20);  // PCM format
  buffer.writeUInt16LE(1, 22);  // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32);  // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(totalSamples * 2, 40);

  let offset = 44;
  for (const freq of notes) {
    const noteSamples = Math.floor(durationPerNote * sampleRate);
    for (let i = 0; i < noteSamples; i++) {
      const t = i / sampleRate;
      // Envelope
      const env = Math.exp(-3 * (i / noteSamples));
      // Tone with a bit of harmonics (marimba/bell feel)
      const sampleVal = freq > 0 
        ? Math.sin(2 * Math.PI * freq * t) * 0.7 + Math.sin(4 * Math.PI * freq * t) * 0.3
        : 0;
      const val = Math.max(-1, Math.min(1, sampleVal * env)) * 16000;
      buffer.writeInt16LE(Math.floor(val), offset);
      offset += 2;
    }
  }
  return buffer;
}

const dir = path.join(__dirname, 'public', 'samples');
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

// Note freqs:
const C4 = 261.63, D4 = 293.66, E4 = 329.63, F4 = 349.23, G4 = 392.00, A4 = 440.00, B4 = 493.88, C5 = 523.25;

// Song 1: Happy Birthday
const s1Notes = [C4, C4, D4, C4, F4, E4, 0, C4, C4, D4, C4, G4, F4, 0, C4, C4, C5, A4, F4, E4, D4, 0, B4, B4, A4, F4, G4, F4];
fs.writeFileSync(path.join(dir, 'Golden Hour.mp3'), createWav(s1Notes, 0.35));

// Song 2: See Tình
const s2Notes = [E4, G4, A4, B4, A4, G4, E4, D4, E4, G4, A4, B4, C5, B4, A4, G4, A4, A4, G4, E4, D4, E4];
fs.writeFileSync(path.join(dir, 'Nhẹ Buông.mp3'), createWav(s2Notes, 0.28));

// Song 3: Cắt Đôi Nỗi Sầu
const s3Notes = [A4, C5, B4, A4, G4, E4, G4, A4, A4, C5, B4, A4, G4, E4, D4, E4, A4, A4, B4, C5, B4, A4, G4, A4];
fs.writeFileSync(path.join(dir, 'chờ chút.mp3'), createWav(s3Notes, 0.28));

console.log('✅ 3 Demo audio files generated in public/samples/');
