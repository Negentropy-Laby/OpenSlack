package processsupervisor

import "errors"

func joinErrors(values ...error) error {
	var present []error
	for _, value := range values {
		if value != nil {
			present = append(present, value)
		}
	}
	return errors.Join(present...)
}
