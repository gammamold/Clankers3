/// Direct-Form II transposed biquad filter.
///
/// Supports bandpass (set_bpf) and one-pole lowpass (set_lpf1) configurations
/// used by the formant synthesizer and glottal-tilt shaping.
///
/// Coefficients are stored pre-divided by a0 so the inner loop is 5 MACs.
pub struct Biquad {
    b0: f32, b1: f32, b2: f32,
    a1: f32, a2: f32,
    s1: f32, s2: f32,
}

impl Biquad {
    pub fn new() -> Self {
        Biquad { b0: 0.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0, s1: 0.0, s2: 0.0 }
    }

    /// Configure as a bandpass with unity peak gain.
    ///
    /// `freq_hz`  — centre frequency in Hz
    /// `bw_hz`    — −3 dB bandwidth in Hz
    /// `sr`       — sample rate in Hz
    pub fn set_bpf(&mut self, freq_hz: f32, bw_hz: f32, sr: f32) {
        let w0    = core::f32::consts::TAU * (freq_hz / sr).clamp(0.001, 0.499);
        let q     = (freq_hz / bw_hz.max(1.0)).max(0.1);
        let alpha = w0.sin() / (2.0 * q);
        let a0    = 1.0 + alpha;
        let half_sin = w0.sin() * 0.5;

        self.b0 =  half_sin / a0;
        self.b1 =  0.0;
        self.b2 = -half_sin / a0;
        self.a1 = -2.0 * w0.cos() / a0;
        self.a2 = (1.0 - alpha) / a0;
    }

    /// One-pole lowpass for glottal spectral tilt: H(z) = (1-c)/(1 - c·z⁻¹).
    ///
    /// `cutoff_hz` — −3 dB frequency in Hz
    pub fn set_lpf1(&mut self, cutoff_hz: f32, sr: f32) {
        let c   = (-core::f32::consts::TAU * cutoff_hz / sr).exp();
        self.b0 = 1.0 - c;
        self.b1 = 0.0;
        self.b2 = 0.0;
        self.a1 = -c;
        self.a2 = 0.0;
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let y    = self.b0 * x + self.s1;
        self.s1  = self.b1 * x - self.a1 * y + self.s2;
        self.s2  = self.b2 * x - self.a2 * y;
        y
    }

    pub fn reset(&mut self) {
        self.s1 = 0.0;
        self.s2 = 0.0;
    }
}
