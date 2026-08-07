package license

import (
	_ "embed"
	"crypto/rsa"
	"errors"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// OpenEdition 开源版免授权模式：开启时 Check() 恒返回已激活，
// 不校验证书、设备指纹与远程授权状态。本项目为开源免费版（恒为 true）；
// 如需恢复授权体系，将其改为 false 并配置 license-server 即可。
const OpenEdition = true

// embeddedPublicKey is the default RSA public key baked into the binary.
// It is copied from license-server/license-public.pem during build so the
// app can verify certificates even when the external pem file is missing.
//
//go:embed license-public.pem
var embeddedPublicKey []byte

// Manager holds the license state and verification key.
type Manager struct {
	serverURL   string
	publicKey   *rsa.PublicKey
	client      *Client
	isActivated bool
	info        Info
}

// Info describes the current activated license.
type Info struct {
	License     string `json:"license"`
	Email       string `json:"email"`
	Type        string `json:"type"`
	ActivatedAt string `json:"activated_at"`
	Fingerprint string `json:"fingerprint"`
	// IsTrial is true when the current certificate is a time-limited trial.
	IsTrial bool `json:"is_trial"`
	// ExpiresAt is the RFC3339 timestamp the trial expires at (empty for perpetual).
	ExpiresAt string `json:"expires_at"`
	// TrialExpired is true when a trial certificate was loaded but is past its exp.
	TrialExpired bool `json:"trial_expired"`
	// DaysLeft is whole days remaining for a trial (0 for perpetual or expired).
	DaysLeft int `json:"days_left"`
}

// Status is the result of a license check.
type Status struct {
	Activated bool `json:"activated"`
	Info      Info `json:"info"`
}

// NewManager creates a license manager with the configured server URL and public key.
func NewManager(serverURL string) (*Manager, error) {
	if serverURL == "" {
		serverURL = os.Getenv("LICENSE_SERVER_URL")
	}
	if serverURL == "" {
		serverURL = "https://www.qihebook.cloud/license-api"
	}

	pub, err := loadPublicKey()
	if err != nil {
		return nil, fmt.Errorf("failed to load public key: %w", err)
	}

	return &Manager{
		serverURL: serverURL,
		publicKey: pub,
		client:    NewClient(serverURL),
	}, nil
}

func loadPublicKey() (*rsa.PublicKey, error) {
	// 1. Environment variable (allows testing and key rotation without rebuild).
	if env := os.Getenv("LICENSE_PUBLIC_KEY"); env != "" {
		return LoadPublicKey([]byte(env))
	}

	// 2. Embedded key copied from license-server/license-public.pem at build time.
	if len(embeddedPublicKey) > 0 {
		if pub, err := LoadPublicKey(embeddedPublicKey); err == nil {
			return pub, nil
		}
	}

	// 3. File next to executable (legacy deployment fallback).
	ex, err := os.Executable()
	if err == nil {
		path := filepath.Join(filepath.Dir(ex), "license-public.pem")
		if pub, err := LoadPublicKeyFromFile(path); err == nil {
			return pub, nil
		}
	}

	// 4. Working directory (development fallback).
	if wd, err := os.Getwd(); err == nil {
		path := filepath.Join(wd, "license-public.pem")
		if pub, err := LoadPublicKeyFromFile(path); err == nil {
			return pub, nil
		}
	}

	return nil, fmt.Errorf("no public key found")
}

// Check loads and verifies the local license certificate.
//
// For perpetual certificates, a valid signature is enough.
// For trial certificates, an expired exp is reported via Status.Info.TrialExpired
// (Activated=false) so the UI can show "trial ended, please activate" instead
// of the generic activation screen.
func (m *Manager) Check() (*Status, error) {
	// 开源免费版：直接视为已激活，跳过证书/设备指纹/远程状态校验。
	if OpenEdition {
		m.isActivated = true
		m.info = Info{
			License:     "OPEN-SOURCE",
			Type:        TypePerpetual,
			ActivatedAt: time.Now().UTC().Format(time.RFC3339),
		}
		return &Status{Activated: true, Info: m.info}, nil
	}

	state, err := LoadLicense()
	if err != nil {
		return &Status{Activated: false}, nil
	}

	claims, err := VerifyCertificate(state.Certificate, m.publicKey)
	if err != nil {
		// Distinguish trial-expiry from genuine invalidity (wrong key, tampering).
		if errors.Is(err, ErrTrialExpired) {
			_ = DeleteLicense()
			fp := DeviceFingerprint()
			return &Status{
				Activated: false,
				Info: Info{
					License:      state.License,
					Type:         TypeTrial,
					IsTrial:      true,
					TrialExpired: true,
					Fingerprint:  fp,
				},
			}, nil
		}
		_ = DeleteLicense()
		return &Status{Activated: false}, nil
	}

	fp := DeviceFingerprint()
	if claims.FP != fp {
		_ = DeleteLicense()
		return &Status{Activated: false}, nil
	}

	m.isActivated = true
	m.info = Info{
		License:     claims.License,
		Email:       claims.Email,
		Type:        claims.Type,
		ActivatedAt: state.ActivatedAt,
		Fingerprint: fp,
	}
	if claims.Type == TypeTrial {
		m.info.IsTrial = true
		if claims.ExpiresAt != nil {
			m.info.ExpiresAt = claims.ExpiresAt.Time.UTC().Format(time.RFC3339)
		}
		m.info.DaysLeft = m.TrialDaysLeft()
	}

	// For perpetual licenses, align with PocketBase so that a disabled license
	// or a removed device becomes invalid on the client side.
	if claims.Type == TypePerpetual && m.client != nil && !strings.HasPrefix(state.License, "TRIAL-") {
		if remote, err := m.client.CheckStatus(state.License, fp); err == nil {
			if remote.Status != "active" {
				_ = DeleteLicense()
				return &Status{Activated: false}, nil
			}
			if !remote.DeviceBound {
				_ = DeleteLicense()
				return &Status{Activated: false}, nil
			}
			// Keep local info in sync with the server record.
			m.info.Email = remote.Email
			m.info.License = remote.License
		} else {
			// Offline or server error: do not lock the user out; rely on the
			// local certificate until the server is reachable again.
			log.Printf("[license] remote status check failed, falling back to local certificate: %v", err)
		}
	}

	return &Status{Activated: true, Info: m.info}, nil
}

// TrialDaysLeft returns whole days remaining in the current trial (0 if expired
// or not a trial). Useful for surfacing "N days left" in the UI.
func (m *Manager) TrialDaysLeft() int {
	if !m.info.IsTrial || m.info.ExpiresAt == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339, m.info.ExpiresAt)
	if err != nil {
		return 0
	}
	d := math.Ceil(time.Until(t).Hours() / 24)
	if d < 0 {
		return 0
	}
	return int(d)
}

// RequestCode asks the server to email a verification code.
func (m *Manager) RequestCode(license, email string) error {
	return m.client.RequestCode(license, email)
}

// Activate completes activation with a verification code.
func (m *Manager) Activate(license, email, code string) (*Status, error) {
	resp, err := m.client.Activate(ActivateRequest{
		License:  license,
		Email:    email,
		Code:     code,
		FP:       DeviceFingerprint(),
		Hostname: mustHostname(),
	})
	if err != nil {
		return nil, err
	}

	claims, err := VerifyCertificate(resp.Certificate, m.publicKey)
	if err != nil {
		return nil, fmt.Errorf("invalid certificate from server: %w", err)
	}

	now := time.Now().UTC().Format(time.RFC3339)
	state := StoredLicense{
		Certificate: resp.Certificate,
		Email:       resp.Email,
		License:     resp.License,
		ActivatedAt: now,
	}
	if err := SaveLicense(state); err != nil {
		return nil, fmt.Errorf("failed to save license: %w", err)
	}

	m.isActivated = true
	m.info = Info{
		License:     claims.License,
		Email:       claims.Email,
		Type:        claims.Type,
		ActivatedAt: now,
		Fingerprint: DeviceFingerprint(),
	}

	return &Status{Activated: true, Info: m.info}, nil
}

// StartTrial asks the server for a device-bound, time-limited trial certificate
// and stores it locally exactly like a regular activation. Returns the new
// status (Activated=true on success).
func (m *Manager) StartTrial() (*Status, error) {
	resp, err := m.client.StartTrial(TrialRequest{
		Fingerprint: DeviceFingerprint(),
		Hostname:    mustHostname(),
	})
	if err != nil {
		return nil, err
	}

	// The server may return an already-expired trial certificate for a device
	// that has previously consumed its window. In that case do not save it as
	// an active license; surface the trial-expired state directly.
	if resp.Expired {
		_ = DeleteLicense()
		fp := DeviceFingerprint()
		return &Status{
			Activated: false,
			Info: Info{
				License:     resp.License,
				Type:        TypeTrial,
				IsTrial:     true,
				TrialExpired: true,
				Fingerprint: fp,
			},
		}, nil
	}

	claims, err := VerifyCertificate(resp.Certificate, m.publicKey)
	if err != nil {
		return nil, fmt.Errorf("invalid trial certificate from server: %w", err)
	}

	now := time.Now().UTC().Format(time.RFC3339)
	state := StoredLicense{
		Certificate: resp.Certificate,
		Email:       resp.Email,
		License:     resp.License,
		ActivatedAt: now,
	}
	if err := SaveLicense(state); err != nil {
		return nil, fmt.Errorf("failed to save trial license: %w", err)
	}

	m.isActivated = true
	m.info = Info{
		License:     claims.License,
		Email:       claims.Email,
		Type:        claims.Type,
		ActivatedAt: now,
		Fingerprint: DeviceFingerprint(),
		IsTrial:     true,
	}
	if claims.ExpiresAt != nil {
		m.info.ExpiresAt = claims.ExpiresAt.Time.UTC().Format(time.RFC3339)
	}
	m.info.DaysLeft = m.TrialDaysLeft()

	return &Status{Activated: true, Info: m.info}, nil
}

// Logout deactivates the current device and clears local license storage.
func (m *Manager) Logout() error {
	state, err := LoadLicense()
	if err == nil && state.License != "" {
		_ = m.client.Deactivate(state.License, DeviceFingerprint())
	}
	_ = DeleteLicense()
	m.isActivated = false
	m.info = Info{}
	return nil
}

// Info returns the current license info.
func (m *Manager) Info() Info {
	return m.info
}

func mustHostname() string {
	h, _ := os.Hostname()
	return h
}
