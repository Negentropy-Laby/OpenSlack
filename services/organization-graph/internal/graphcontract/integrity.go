package graphcontract

import (
	"crypto/subtle"

	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphjson"
)

const emptyHash = "sha256:0000000000000000000000000000000000000000000000000000000000000000"

func snapshotDigestValue(value Snapshot) graphjson.Object {
	full := SnapshotValue(value)
	delete(full, "generatedAt")
	delete(full, "integrityHash")
	return full
}

func deltaDigestValue(value Delta) graphjson.Object {
	full := DeltaValue(value)
	delete(full, "generatedAt")
	delete(full, "integrityHash")
	return full
}

func digestPrefixed(value graphjson.Value) (string, error) {
	hash, err := digestValue(value)
	if err != nil {
		return "", err
	}
	return "sha256:" + hash, nil
}

func CalculateSnapshotIntegrity(value Snapshot) (string, error) {
	canonical, err := CanonicalizeSnapshot(value)
	if err != nil {
		return "", err
	}
	return digestPrefixed(snapshotDigestValue(canonical))
}

func CalculateDeltaIntegrity(value Delta) (string, error) {
	canonical, err := CanonicalizeDelta(value)
	if err != nil {
		return "", err
	}
	return digestPrefixed(deltaDigestValue(canonical))
}

func SealSnapshot(value Snapshot) (Snapshot, error) {
	value.Schema = SnapshotSchema
	value.IntegrityHash = emptyHash
	canonical, err := CanonicalizeSnapshot(value)
	if err != nil {
		return Snapshot{}, err
	}
	canonical.IntegrityHash, err = digestPrefixed(snapshotDigestValue(canonical))
	return canonical, err
}

func SealDelta(value Delta) (Delta, error) {
	value.Schema = DeltaSchema
	value.IntegrityHash = emptyHash
	canonical, err := CanonicalizeDelta(value)
	if err != nil {
		return Delta{}, err
	}
	canonical.IntegrityHash, err = digestPrefixed(deltaDigestValue(canonical))
	return canonical, err
}

func hashEqual(left, right string) bool {
	if len(left) != len(right) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func VerifySnapshotIntegrity(value Snapshot) (bool, error) {
	canonical, err := CanonicalizeSnapshot(value)
	if err != nil {
		return false, err
	}
	expected, err := digestPrefixed(snapshotDigestValue(canonical))
	return err == nil && hashEqual(canonical.IntegrityHash, expected), err
}

func VerifyDeltaIntegrity(value Delta) (bool, error) {
	canonical, err := CanonicalizeDelta(value)
	if err != nil {
		return false, err
	}
	expected, err := digestPrefixed(deltaDigestValue(canonical))
	return err == nil && hashEqual(canonical.IntegrityHash, expected), err
}

func AssertSnapshotIntegrity(value Snapshot) (Snapshot, error) {
	canonical, err := CanonicalizeSnapshot(value)
	if err != nil {
		return Snapshot{}, err
	}
	expected, err := digestPrefixed(snapshotDigestValue(canonical))
	if err != nil {
		return Snapshot{}, err
	}
	if !hashEqual(canonical.IntegrityHash, expected) {
		return Snapshot{}, failure(ErrorIntegrityInvalid, "$.integrityHash", "does not match canonical content digest "+expected)
	}
	return canonical, nil
}

func AssertDeltaIntegrity(value Delta) (Delta, error) {
	canonical, err := CanonicalizeDelta(value)
	if err != nil {
		return Delta{}, err
	}
	expected, err := digestPrefixed(deltaDigestValue(canonical))
	if err != nil {
		return Delta{}, err
	}
	if !hashEqual(canonical.IntegrityHash, expected) {
		return Delta{}, failure(ErrorIntegrityInvalid, "$.integrityHash", "does not match canonical content digest "+expected)
	}
	return canonical, nil
}

func SerializeSnapshot(value Snapshot) ([]byte, error) {
	canonical, err := AssertSnapshotIntegrity(value)
	if err != nil {
		return nil, err
	}
	encoded, err := graphjson.Encode(SnapshotValue(canonical))
	if err != nil {
		return nil, err
	}
	return append(encoded, '\n'), nil
}

func SerializeDelta(value Delta) ([]byte, error) {
	canonical, err := AssertDeltaIntegrity(value)
	if err != nil {
		return nil, err
	}
	encoded, err := graphjson.Encode(DeltaValue(canonical))
	if err != nil {
		return nil, err
	}
	return append(encoded, '\n'), nil
}
