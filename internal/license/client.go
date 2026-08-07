package license

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client talks to the license server.
type Client struct {
	baseURL string
	http    *http.Client
}

// NewClient creates a new license server client.
func NewClient(baseURL string) *Client {
	return &Client{
		baseURL: baseURL,
		http:    &http.Client{Timeout: 30 * time.Second},
	}
}

type apiResponse struct {
	Code    int            `json:"code"`
	Message string         `json:"message"`
	Data    map[string]any `json:"data"`
}

// RequestCode asks the license server to send a verification code.
func (c *Client) RequestCode(license, email string) error {
	body := map[string]string{"license": license, "email": email}
	_, err := c.post("/api/license/request-code", body)
	return err
}

// ActivateRequest is the payload for license activation.
type ActivateRequest struct {
	License  string `json:"license"`
	Email    string `json:"email"`
	Code     string `json:"code"`
	FP       string `json:"fingerprint"`
	Hostname string `json:"hostname"`
}

// ActivateResponse is returned after successful activation or trial start.
type ActivateResponse struct {
	Certificate string `json:"certificate"`
	License     string `json:"license"`
	Email       string `json:"email"`
	Type        string `json:"type"`
	Expired     bool   `json:"expired"`
}

// Activate exchanges a verification code for a signed certificate.
func (c *Client) Activate(req ActivateRequest) (*ActivateResponse, error) {
	resp, err := c.post("/api/license/activate", req)
	if err != nil {
		return nil, err
	}
	cert, _ := resp.Data["certificate"].(string)
	if cert == "" {
		return nil, fmt.Errorf("activation response missing certificate")
	}
	return &ActivateResponse{
		Certificate: cert,
		License:     toString(resp.Data["license"]),
		Email:       toString(resp.Data["email"]),
		Type:        toString(resp.Data["type"]),
	}, nil
}

// Deactivate unbinds the current device from the license.
func (c *Client) Deactivate(license, fp string) error {
	body := map[string]string{"license": license, "fingerprint": fp}
	_, err := c.post("/api/license/deactivate", body)
	return err
}

// RemoteStatus is the license state returned by the server.
type RemoteStatus struct {
	License     string `json:"license"`
	Email       string `json:"email"`
	Status      string `json:"status"`
	MaxDevices  int    `json:"max_devices"`
	DeviceCount int    `json:"device_count"`
	DeviceBound bool   `json:"device_bound"`
}

// CheckStatus asks the license server whether the license is still active and
// whether the current device is still bound. When the fingerprint is provided,
// the server also refreshes the device's last_seen_at timestamp.
func (c *Client) CheckStatus(license, fingerprint string) (*RemoteStatus, error) {
	resp, err := c.post("/api/license/status", map[string]string{
		"license":     license,
		"fingerprint": fingerprint,
	})
	if err != nil {
		return nil, err
	}
	status := &RemoteStatus{
		License:     toString(resp.Data["license"]),
		Email:       toString(resp.Data["email"]),
		Status:      toString(resp.Data["status"]),
		MaxDevices:  toInt(resp.Data["max_devices"]),
		DeviceCount: toInt(resp.Data["device_count"]),
	}
	if v, ok := resp.Data["device_bound"].(bool); ok {
		status.DeviceBound = v
	}
	return status, nil
}

func toInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	default:
		return 0
	}
}

// TrialRequest is the payload for starting a device-bound trial.
type TrialRequest struct {
	Fingerprint string `json:"fingerprint"`
	Hostname    string `json:"hostname"`
}

// StartTrial asks the server to issue (or reissue) a time-limited trial
// certificate for this device. The server enforces one trial per fingerprint,
// so calling this repeatedly returns the original (possibly expired) window.
func (c *Client) StartTrial(req TrialRequest) (*ActivateResponse, error) {
	resp, err := c.post("/api/license/trial", req)
	if err != nil {
		return nil, err
	}
	cert, _ := resp.Data["certificate"].(string)
	if cert == "" {
		return nil, fmt.Errorf("trial response missing certificate")
	}
	result := &ActivateResponse{
		Certificate: cert,
		License:     toString(resp.Data["license"]),
		Email:       toString(resp.Data["email"]),
		Type:        toString(resp.Data["type"]),
	}
	if v, ok := resp.Data["expired"].(bool); ok {
		result.Expired = v
	}
	return result, nil
}

func (c *Client) post(path string, payload any) (*apiResponse, error) {
	jsonBody, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	resp, err := c.http.Post(c.baseURL+path, "application/json", bytes.NewReader(jsonBody))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var apiResp apiResponse
	if err := json.Unmarshal(body, &apiResp); err != nil {
		return nil, fmt.Errorf("invalid response: %s", string(body))
	}

	if resp.StatusCode != http.StatusOK || apiResp.Code != 200 {
		if apiResp.Message != "" {
			// Use errors.New so a server-controlled message containing "%"
			// cannot be misinterpreted as a fmt verb.
			return nil, errors.New(apiResp.Message)
		}
		return nil, fmt.Errorf("license server error: %d", resp.StatusCode)
	}

	return &apiResp, nil
}

func toString(v any) string {
	s, _ := v.(string)
	return s
}
