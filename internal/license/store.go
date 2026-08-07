package license

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// StoredLicense is the local encrypted license state.
type StoredLicense struct {
	Certificate string `json:"certificate"`
	Email       string `json:"email"`
	License     string `json:"license"`
	ActivatedAt string `json:"activated_at"`
}

// licenseStorePath returns the path to the encrypted license file.
func licenseStorePath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, "AppData", "Local", "QiheFileManager")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	return filepath.Join(dir, "license.dat"), nil
}

// deriveKey creates a 32-byte AES key from the device fingerprint.
func deriveKey(fp string) []byte {
	sum := sha256.Sum256([]byte(fp))
	return sum[:]
}

// SaveLicense stores the license certificate encrypted with the device fingerprint.
func SaveLicense(state StoredLicense) error {
	path, err := licenseStorePath()
	if err != nil {
		return err
	}
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	encrypted, err := encrypt(data, deriveKey(DeviceFingerprint()))
	if err != nil {
		return err
	}
	return os.WriteFile(path, encrypted, 0600)
}

// LoadLicense loads and decrypts the stored license certificate.
func LoadLicense() (*StoredLicense, error) {
	path, err := licenseStorePath()
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	decrypted, err := decrypt(data, deriveKey(DeviceFingerprint()))
	if err != nil {
		return nil, err
	}
	var state StoredLicense
	if err := json.Unmarshal(decrypted, &state); err != nil {
		return nil, err
	}
	return &state, nil
}

// DeleteLicense removes the local license file.
func DeleteLicense() error {
	path, err := licenseStorePath()
	if err != nil {
		return err
	}
	return os.Remove(path)
}

func encrypt(plaintext, key []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, plaintext, nil), nil
}

func decrypt(ciphertext, key []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(ciphertext) < gcm.NonceSize() {
		return nil, fmt.Errorf("ciphertext too short")
	}
	nonce, ciphertext := ciphertext[:gcm.NonceSize()], ciphertext[gcm.NonceSize():]
	return gcm.Open(nil, nonce, ciphertext, nil)
}
