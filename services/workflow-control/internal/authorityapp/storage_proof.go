package authorityapp

import (
	"context"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/storageproof"
	"net/http"
	"strconv"
)

const RouteStorageProof = "/v1/workflow-control/storage-proof"

func (service *Service) handleStorageProof(w http.ResponseWriter, request *http.Request) {
	q := request.URL.Query()
	key, e1 := strconv.ParseInt(q.Get("key"), 10, 64)
	pid, e2 := strconv.ParseInt(q.Get("pid"), 10, 32)
	if request.ContentLength != 0 || len(q) != 2 || len(q["key"]) != 1 || len(q["pid"]) != 1 ||
		e1 != nil || e2 != nil || key <= 0 || pid <= 0 || strconv.FormatInt(key, 10) != q.Get("key") || strconv.FormatInt(pid, 10) != q.Get("pid") {
		writeFailure(w, http.StatusUnprocessableEntity, "WORKFLOW_CONTROL_AUTHORITY_UNPROCESSABLE", "storage challenge is invalid")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), readDeadline)
	defer cancel()
	answer, err := service.repository.ProveStorage(ctx, storageproof.Challenge{Key: key, PID: int32(pid)})
	if err != nil {
		writeFailure(w, http.StatusServiceUnavailable, "WORKFLOW_CONTROL_AUTHORITY_UNAVAILABLE", "source writer storage proof is unavailable")
		return
	}
	writeCanonical(w, http.StatusOK, answer)
}
