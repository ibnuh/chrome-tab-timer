// Offscreen document for playing notification sounds
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'PLAY_SOUND') {
    playNotificationSound();
  }
});

function playNotificationSound() {
  const ctx = new AudioContext();
  const now = ctx.currentTime;

  // Play a pleasant two-tone chime
  playTone(ctx, 880, now, 0.15);        // A5
  playTone(ctx, 1108.73, now + 0.18, 0.2); // C#6
  playTone(ctx, 1318.51, now + 0.4, 0.3);  // E6

  // Close context after sound finishes
  setTimeout(() => ctx.close(), 1500);
}

function playTone(ctx, freq, startTime, duration) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.value = freq;

  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(0.3, startTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(startTime);
  osc.stop(startTime + duration);
}
