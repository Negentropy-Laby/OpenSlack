package runnerscheduler

import (
	"io"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
)

func newV2FrameReader(source io.Reader) *protocolFrameReader[authoritycontract.Message] {
	return newProtocolFrameReader(source, authoritycontract.MaxMessageBytes, "runner v2", authoritycontract.DecodeMessageJSON)
}
