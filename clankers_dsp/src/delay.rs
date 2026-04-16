/// Feedback delay line with tanh soft-clip safety.
/// Max delay 2 seconds at 44100 Hz.

pub struct DelayLine {
    buf: Vec<f32>,
    write_pos: usize,
    sr: f32,
}

impl DelayLine {
    pub fn new(sample_rate: f32) -> Self {
        let size = (sample_rate as usize) * 2;
        DelayLine {
            buf: vec![0.0; size.max(1)],
            write_pos: 0,
            sr: sample_rate,
        }
    }

    pub fn reset(&mut self) {
        self.buf.fill(0.0);
        self.write_pos = 0;
    }

    /// Process one sample.
    /// time_s   : delay time in seconds (0.01..2.0)
    /// feedback : feedback amount (0.0..0.95)
    /// mix      : wet/dry mix (0.0..1.0)
    #[inline]
    pub fn process(&mut self, x: f32, time_s: f32, feedback: f32, mix: f32) -> f32 {
        let delay_samples = (time_s * self.sr).clamp(1.0, (self.buf.len() - 1) as f32);
        let read_pos = (self.write_pos as f32 - delay_samples + self.buf.len() as f32) % self.buf.len() as f32;

        // Linear interpolation for fractional delay
        let idx0 = read_pos as usize;
        let idx1 = (idx0 + 1) % self.buf.len();
        let frac = read_pos - idx0 as f32;
        let delayed = self.buf[idx0] * (1.0 - frac) + self.buf[idx1] * frac;

        // Write with feedback (tanh soft-clip to prevent runaway)
        let fb = feedback.clamp(0.0, 0.95);
        self.buf[self.write_pos] = x + (delayed * fb).tanh();
        self.write_pos = (self.write_pos + 1) % self.buf.len();

        // Wet/dry mix
        let mix = mix.clamp(0.0, 1.0);
        x * (1.0 - mix) + delayed * mix
    }
}
