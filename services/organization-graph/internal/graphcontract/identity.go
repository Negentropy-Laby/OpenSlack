package graphcontract

import (
	"crypto/sha256"
	"encoding/hex"

	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphjson"
)

func digestValue(value graphjson.Value) (string, error) {
	encoded, err := graphjson.Encode(value)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(encoded)
	return hex.EncodeToString(hash[:]), nil
}

func authorityIdentity(value AuthorityRef) graphjson.Object {
	return graphjson.Object{
		"objectId": value.ObjectID, "objectType": value.ObjectType, "provider": value.Provider,
	}
}

func DeriveNodeID(scenarioInstanceID, nodeType string, authority AuthorityRef) (string, error) {
	value, err := digestValue(graphjson.Object{
		"authority": authorityIdentity(authority), "scenarioInstanceId": scenarioInstanceID,
		"type": nodeType,
	})
	if err != nil {
		return "", err
	}
	return "node:sha256:" + value, nil
}

func DeriveEdgeID(scenarioInstanceID, edgeType, from, to string, authority *AuthorityRef) (string, error) {
	value := graphjson.Object{
		"from": from, "scenarioInstanceId": scenarioInstanceID, "to": to, "type": edgeType,
	}
	if authority != nil {
		value["authority"] = authorityIdentity(*authority)
	}
	hash, err := digestValue(value)
	if err != nil {
		return "", err
	}
	return "edge:sha256:" + hash, nil
}
