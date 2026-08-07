package license

import "errors"

// License type constants used in certificates and UI.
const (
	TypeTrial     = "trial"
	TypePerpetual = "perpetual"
)

// ErrTrialExpired is returned by VerifyCertificate when a trial certificate's
// expiration time has passed. It allows the UI to distinguish "trial ended"
// from an invalid or tampered certificate.
var ErrTrialExpired = errors.New("trial period has expired")
