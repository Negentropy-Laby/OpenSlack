package storageproof

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"unicode/utf8"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
)

// NewClient receives the existing, authenticated source connection binding.
// Redirects are refused so the writer's credential cannot leave its configured origin.
func NewClient(origin, token, workspace, caller, build string) ChallengeWriter {
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return func(ctx context.Context, challenge Challenge, epoch int64) (Answer, error) {
		answer := Answer{}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, origin+"/v1/workflow-control/storage-proof?key="+strconv.FormatInt(challenge.Key, 10)+"&pid="+strconv.FormatInt(int64(challenge.PID), 10), nil)
		if err != nil {
			return answer, err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("X-OpenSlack-Workflow-Control-Workspace-ID", workspace)
		req.Header.Set("X-OpenSlack-Workflow-Control-Caller-ID", caller)
		req.Header.Set("X-OpenSlack-Workflow-Control-Routing-Epoch", strconv.FormatInt(epoch, 10))
		req.Header.Set("X-OpenSlack-Workflow-Control-Expected-Build-SHA", build)
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Accept-Encoding", "identity")
		resp, err := client.Do(req)
		if err != nil {
			return answer, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "application/json" || resp.Header.Get("Content-Encoding") != "" {
			return answer, errors.New("source writer proof unavailable")
		}
		raw, err := io.ReadAll(io.LimitReader(resp.Body, 16*1024+1))
		if err != nil {
			return answer, err
		}
		if len(raw) > 16*1024 || !utf8.Valid(raw) {
			return answer, errors.New("source writer proof exceeds contract")
		}
		if err = json.Unmarshal(raw, &answer); err != nil {
			return answer, err
		}
		exact, err := canonicaljson.Encode(answer)
		if err != nil || !bytes.Equal(append(exact, '\n'), raw) || answer.Schema != Schema || answer.Challenge != challenge {
			return answer, errors.New("source writer proof identity differs")
		}
		return answer, nil
	}
}
