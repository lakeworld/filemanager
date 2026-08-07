package license

import (
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"os"

	"github.com/golang-jwt/jwt/v5"
)

// CertificateClaims represents the decoded license certificate.
type CertificateClaims struct {
	License string `json:"lic"`
	Email   string `json:"email"`
	FP      string `json:"fp"`
	Type    string `json:"type"`
	jwt.RegisteredClaims
}

// LoadPublicKey loads an RSA public key from PEM bytes or a PEM file path.
func LoadPublicKey(pemData []byte) (*rsa.PublicKey, error) {
	block, _ := pem.Decode(pemData)
	if block == nil {
		return nil, fmt.Errorf("failed to decode PEM block")
	}
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	rsaPub, ok := pub.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("not an RSA public key")
	}
	return rsaPub, nil
}

// LoadPublicKeyFromFile loads an RSA public key from a PEM file.
func LoadPublicKeyFromFile(path string) (*rsa.PublicKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return LoadPublicKey(data)
}

// VerifyCertificate validates a signed license certificate and returns its claims.
// Expired trial certificates are reported as ErrTrialExpired so the UI can show a
// dedicated "trial ended" state instead of a generic error.
func VerifyCertificate(tokenString string, pub *rsa.PublicKey) (*CertificateClaims, error) {
	parse := func(opts ...jwt.ParserOption) (*jwt.Token, error) {
		return jwt.ParseWithClaims(tokenString, &CertificateClaims{}, func(token *jwt.Token) (interface{}, error) {
			if _, ok := token.Method.(*jwt.SigningMethodRSA); !ok {
				return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
			}
			return pub, nil
		}, opts...)
	}

	token, err := parse()
	if err != nil {
		// Expired trial tokens need special handling: we still want to verify the
		// signature to distinguish a genuinely expired trial from a tampered one.
		if errors.Is(err, jwt.ErrTokenExpired) {
			unsigned, unsignedErr := parse(jwt.WithoutClaimsValidation())
			if unsignedErr == nil {
				if claims, ok := unsigned.Claims.(*CertificateClaims); ok && unsigned.Valid && claims.Type == TypeTrial {
					return nil, ErrTrialExpired
				}
			}
		}
		return nil, err
	}

	if claims, ok := token.Claims.(*CertificateClaims); ok && token.Valid {
		return claims, nil
	}
	return nil, fmt.Errorf("invalid certificate")
}
