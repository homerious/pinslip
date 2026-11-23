package server

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const pairingLifetime = 2 * time.Minute

type LocalAccess struct {
	desktopDigest  [sha256.Size]byte
	desktopEnabled bool
	devOrigin      string
	clipperPath    string
	mu             sync.Mutex
	pairingDigest  [sha256.Size]byte
	pairingUntil   time.Time
	clippers       []string
}

func NewLocalAccess(desktopToken, devOrigin, clipperPath string) (*LocalAccess, error) {
	a := &LocalAccess{
		desktopDigest: sha256.Sum256([]byte(desktopToken)), desktopEnabled: desktopToken != "",
		devOrigin: devOrigin, clipperPath: clipperPath,
	}
	if clipperPath == "" {
		return a, nil
	}
	data, err := os.ReadFile(clipperPath)
	if errors.Is(err, os.ErrNotExist) {
		return a, nil
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(data, &a.clippers); err != nil {
		return nil, err
	}
	return a, nil
}

func randomCredential(size int) (string, error) {
	b := make([]byte, size)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func (a *LocalAccess) validClipper(digest [sha256.Size]byte) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	value := hex.EncodeToString(digest[:])
	for _, registered := range a.clippers {
		if subtle.ConstantTimeCompare([]byte(registered), []byte(value)) == 1 {
			return true
		}
	}
	return false
}

func (a *LocalAccess) beginPairing(w http.ResponseWriter, _ *http.Request) {
	if a.clipperPath == "" {
		http.Error(w, "Clipper pairing unavailable", http.StatusServiceUnavailable)
		return
	}
	code, err := randomCredential(16)
	if err != nil {
		http.Error(w, "Unable to create pairing code", http.StatusInternalServerError)
		return
	}
	expires := time.Now().Add(pairingLifetime)
	a.mu.Lock()
	a.pairingDigest = sha256.Sum256([]byte(code))
	a.pairingUntil = expires
	a.mu.Unlock()
	writeLocalJSON(w, http.StatusOK, map[string]any{"code": code, "expiresAt": expires})
}

func (a *LocalAccess) connectClipper(w http.ResponseWriter, r *http.Request) {
	var input struct{ Code string }
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	if err := dec.Decode(&input); err != nil || dec.Decode(new(any)) != io.EOF || len(input.Code) != 22 {
		http.Error(w, "Invalid pairing code", http.StatusBadRequest)
		return
	}
	codeDigest := sha256.Sum256([]byte(input.Code))
	a.mu.Lock()
	defer a.mu.Unlock()
	if !time.Now().Before(a.pairingUntil) || subtle.ConstantTimeCompare(codeDigest[:], a.pairingDigest[:]) != 1 {
		http.Error(w, "Invalid or expired pairing code", http.StatusUnauthorized)
		return
	}
	token, err := randomCredential(32)
	if err != nil {
		http.Error(w, "Unable to create clipper credential", http.StatusInternalServerError)
		return
	}
	digest := sha256.Sum256([]byte(token))
	next := append(append([]string(nil), a.clippers...), hex.EncodeToString(digest[:]))
	if err := a.saveClippers(next); err != nil {
		http.Error(w, "Unable to save clipper credential", http.StatusInternalServerError)
		return
	}
	a.pairingUntil = time.Time{}
	writeLocalJSON(w, http.StatusOK, map[string]string{"token": token})
}

func (a *LocalAccess) revokeClippers(w http.ResponseWriter, _ *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.saveClippers(nil); err != nil {
		http.Error(w, "Unable to revoke clipper credentials", http.StatusInternalServerError)
		return
	}
	a.pairingUntil = time.Time{}
	writeLocalJSON(w, http.StatusOK, map[string]bool{"revoked": true})
}

// 持锁落盘。在替换成功后更新内存，读写异常不会提早确认配对或撤销。
func (a *LocalAccess) saveClippers(next []string) error {
	f, err := os.CreateTemp(filepath.Dir(a.clipperPath), ".clipper-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	writeErr := json.NewEncoder(f).Encode(next)
	closeErr := f.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return err
	}
	if err := os.Rename(f.Name(), a.clipperPath); err != nil {
		return err
	}
	a.clippers = next
	return nil
}
