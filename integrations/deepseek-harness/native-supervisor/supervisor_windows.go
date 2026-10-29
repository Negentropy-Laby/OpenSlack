//go:build windows

package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"runtime"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// PROC_THREAD_ATTRIBUTE_JOB_LIST is a documented Windows 10+/Server 2016+
// creation attribute. x/sys v0.25.0 exposes the attribute API, but not this name.
const procThreadAttributeJobList = uintptr(0x0002000D)

type jobAccounting struct {
	UserTime, KernelTime, PeriodUserTime, PeriodKernelTime           int64
	PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses uint32
}

type childTree struct {
	job, process, thread  windows.Handle
	pid                   uint32
	input, output, stderr *os.File
}

type creationHooks struct {
	createJob    func() (windows.Handle, error)
	beforeCreate func(windows.Handle)
}

func createChild(config options) (*childTree, error) {
	return createChildWithHooks(config, creationHooks{})
}

// The private seam exercises real creation-time failure paths without adding
// fault flags or a general-purpose process API to the distributed helper.
func createChildWithHooks(config options, hooks creationHooks) (_ *childTree, resultErr error) {
	tree := &childTree{}
	defer func() {
		if resultErr != nil {
			tree.close()
		}
	}()
	var err error
	if hooks.createJob != nil {
		tree.job, err = hooks.createJob()
	} else {
		tree.job, err = windows.CreateJobObject(nil, nil)
	}
	if err != nil {
		return nil, err
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(tree.job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		return nil, err
	}
	attrs, err := windows.NewProcThreadAttributeList(2)
	if err != nil {
		return nil, err
	}
	defer attrs.Delete()
	// Association is part of CreateProcess, so even a helper crash between creation
	// and ResumeThread cannot leave an unowned suspended process behind.
	if err = attrs.Update(procThreadAttributeJobList, unsafe.Pointer(&tree.job), unsafe.Sizeof(tree.job)); err != nil {
		return nil, err
	}
	var inputRead, inputWrite, outputRead, outputWrite, errorRead, errorWrite windows.Handle
	childHandles := []*windows.Handle{&inputRead, &outputWrite, &errorWrite}
	defer func() {
		for _, handle := range childHandles {
			if *handle != 0 {
				windows.CloseHandle(*handle)
			}
		}
	}()
	security := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), InheritHandle: 1}
	if err = windows.CreatePipe(&inputRead, &inputWrite, &security, 0); err != nil {
		return nil, err
	}
	tree.input = os.NewFile(uintptr(inputWrite), "owned-peer-input")
	if err = windows.SetHandleInformation(inputWrite, windows.HANDLE_FLAG_INHERIT, 0); err != nil {
		return nil, err
	}
	if err = windows.CreatePipe(&outputRead, &outputWrite, &security, 0); err != nil {
		return nil, err
	}
	tree.output = os.NewFile(uintptr(outputRead), "owned-peer-output")
	if err = windows.SetHandleInformation(outputRead, windows.HANDLE_FLAG_INHERIT, 0); err != nil {
		return nil, err
	}
	if err = windows.CreatePipe(&errorRead, &errorWrite, &security, 0); err != nil {
		return nil, err
	}
	tree.stderr = os.NewFile(uintptr(errorRead), "owned-peer-error")
	if err = windows.SetHandleInformation(errorRead, windows.HANDLE_FLAG_INHERIT, 0); err != nil {
		return nil, err
	}
	handles := []windows.Handle{inputRead, outputWrite, errorWrite}
	if err = attrs.Update(windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, unsafe.Pointer(&handles[0]),
		uintptr(len(handles))*unsafe.Sizeof(handles[0])); err != nil {
		return nil, err
	}
	startup := windows.StartupInfoEx{ProcThreadAttributeList: attrs.List()}
	startup.Cb = uint32(unsafe.Sizeof(startup))
	startup.Flags = windows.STARTF_USESTDHANDLES
	startup.StdInput, startup.StdOutput, startup.StdErr = inputRead, outputWrite, errorWrite
	application, err := windows.UTF16PtrFromString(config.command[0])
	if err != nil {
		return nil, err
	}
	command, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(config.command))
	if err != nil {
		return nil, err
	}
	var created windows.ProcessInformation
	if hooks.beforeCreate != nil {
		hooks.beforeCreate(tree.job)
	}
	err = windows.CreateProcess(application, command, nil, nil, true,
		windows.CREATE_SUSPENDED|windows.EXTENDED_STARTUPINFO_PRESENT|windows.CREATE_UNICODE_ENVIRONMENT,
		nil, nil, &startup.StartupInfo, &created)
	runtime.KeepAlive(handles)
	runtime.KeepAlive(tree)
	if err != nil {
		return nil, err
	}
	tree.process, tree.thread, tree.pid = created.Process, created.Thread, created.ProcessId
	var assigned int32
	call := windows.NewLazySystemDLL("kernel32.dll").NewProc("IsProcessInJob")
	verified, _, verifyErr := call.Call(uintptr(tree.process), uintptr(tree.job), uintptr(unsafe.Pointer(&assigned)))
	if verified == 0 || assigned == 0 {
		windows.TerminateJobObject(tree.job, 1)
		return nil, errors.Join(errors.New("creation-time Job association unconfirmed"), verifyErr)
	}
	return tree, nil
}

func (tree *childTree) close() {
	// The Job handle is deliberately not inherited, so its last close kills the
	// entire owned tree even when the helper is interrupted before it can receipt.
	if tree.job != 0 {
		windows.CloseHandle(tree.job)
		tree.job = 0
	}
	if tree.thread != 0 {
		windows.CloseHandle(tree.thread)
		tree.thread = 0
	}
	if tree.process != 0 {
		windows.CloseHandle(tree.process)
		tree.process = 0
	}
	for _, file := range []*os.File{tree.input, tree.output, tree.stderr} {
		if file != nil {
			// A synchronous pipe writer may own File's close lock. The Job close
			// above is the termination backstop; never block the cleanup clock.
			go file.Close()
		}
	}
}

func (tree *childTree) empty() (bool, error) {
	var info jobAccounting
	var returned uint32
	err := windows.QueryInformationJobObject(tree.job, windows.JobObjectBasicAccountingInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), &returned)
	if err == nil && returned != uint32(unsafe.Sizeof(info)) {
		err = errors.New("incomplete Job accounting receipt")
	}
	return info.ActiveProcesses == 0, err
}

func supervise(config options) error {
	tree, err := createChild(config)
	if err != nil {
		return err
	}
	defer tree.close()
	var outputLock sync.Mutex
	write := func(kind string, fields map[string]any) error {
		outputLock.Lock()
		defer outputLock.Unlock()
		fields["protocol"], fields["runId"], fields["generation"], fields["kind"] = protocol, config.runID, config.generation, kind
		return json.NewEncoder(os.Stdout).Encode(fields)
	}
	if err = write("spawned", map[string]any{"pid": tree.pid}); err != nil {
		return err
	}
	outputDone := make(chan error, 1)
	go func() {
		buffer := make([]byte, 64*1024)
		for {
			n, readErr := tree.output.Read(buffer)
			if n > 0 {
				if err := write("bridge-bytes", map[string]any{"data": base64.StdEncoding.EncodeToString(buffer[:n])}); err != nil {
					outputDone <- err
					return
				}
			}
			if readErr != nil {
				if readErr == io.EOF {
					readErr = nil
				}
				outputDone <- readErr
				return
			}
		}
	}()
	errorDone := make(chan error, 1)
	go func() { _, err := io.Copy(io.Discard, tree.stderr); errorDone <- err }()
	// Detect host EOF independently of a blocked child stdin write. This queue is
	// bounded at 32 MiB; overflow is an explicit stop, not an unbounded allocation
	// or a reader blocked forever before it can observe EOF.
	inputDone := make(chan error, 1)
	inputQueue := make(chan []byte, 512)
	go func() {
		defer close(inputQueue)
		buffer := make([]byte, 64*1024)
		for {
			n, readErr := os.Stdin.Read(buffer)
			if n > 0 {
				select {
				case inputQueue <- append([]byte(nil), buffer[:n]...):
				default:
					inputDone <- errors.New("supervisor input queue exceeded its bound")
					return
				}
			}
			if readErr != nil {
				if readErr == io.EOF {
					readErr = nil
				}
				inputDone <- readErr
				return
			}
		}
	}()
	inputWriteError := make(chan error, 1)
	go func() {
		defer tree.input.Close()
		for bytes := range inputQueue {
			if _, err := tree.input.Write(bytes); err != nil {
				inputWriteError <- err
				return
			}
		}
	}()
	if _, err = windows.ResumeThread(tree.thread); err != nil {
		return err
	}
	windows.CloseHandle(tree.thread)
	tree.thread = 0
	rootDone := make(chan error, 1)
	processHandle := tree.process
	go func() {
		status, err := windows.WaitForSingleObject(processHandle, windows.INFINITE)
		if err == nil && status != windows.WAIT_OBJECT_0 {
			err = errors.New("root process wait was not signaled")
		}
		rootDone <- err
	}()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	var deadline, forceAt time.Time
	rootStopped, stdoutStopped, stderrStopped := false, false, false
	forced, uncertain := false, false
	beginClosing := func() {
		if deadline.IsZero() {
			deadline = time.Now().Add(config.cleanup)
			forceAt = deadline.Add(-config.cleanup / 6)
			// EOF closes the queue; its writer must drain already accepted tail
			// bytes before closing child stdin. The independent deadline never
			// waits for that writer, including when the child does not read.
		}
	}
	for {
		select {
		case err := <-inputDone:
			uncertain = uncertain || err != nil
			beginClosing()
			inputDone = nil
		case err := <-inputWriteError:
			// A peer may exit before the parent's final write is flushed. The
			// underlying Bridge decides whether business output is complete.
			_ = err
			beginClosing()
			inputWriteError = nil
		case err := <-rootDone:
			rootStopped = err == nil
			uncertain = uncertain || err != nil
			beginClosing()
			rootDone = nil
		case err := <-outputDone:
			stdoutStopped = err == nil
			uncertain = uncertain || err != nil
			outputDone = nil
			if err != nil {
				beginClosing()
			}
		case err := <-errorDone:
			stderrStopped = err == nil
			uncertain = uncertain || err != nil
			errorDone = nil
			if err != nil {
				beginClosing()
			}
		case <-ticker.C:
		}
		empty, queryErr := tree.empty()
		if queryErr != nil {
			uncertain = true
			beginClosing()
		}
		if !deadline.IsZero() && !time.Now().Before(deadline) {
			// A late clean observation is still beyond the one absolute cutoff;
			// it cannot win a race with an already-expired receipt timer.
			return errors.New("owned process stop was not observed by the deadline")
		}
		if rootStopped && empty && stdoutStopped && stderrStopped && !uncertain {
			var code uint32
			if err := windows.GetExitCodeProcess(tree.process, &code); err != nil {
				return err
			}
			receipted := make(chan error, 1)
			go func() {
				receipted <- write("exit-receipt", map[string]any{"pid": tree.pid, "rootExitCode": code, "jobEmpty": true,
					"streamsDrained": true, "terminationRequested": forced, "graceful": !forced && code == 0,
					"timedOut": forced})
			}()
			select {
			case err := <-receipted:
				if err != nil {
					return err
				}
			case <-time.After(time.Until(deadline)):
				go os.Stdout.Close()
				return errors.New("supervisor receipt exceeded the cleanup cutoff")
			}
			if !time.Now().Before(deadline) {
				return errors.New("supervisor receipt exceeded the cleanup cutoff")
			}
			if forced || code != 0 {
				return errors.New("owned process did not stop cleanly")
			}
			return nil
		}
		if !forceAt.IsZero() && !time.Now().Before(forceAt) && !forced {
			forced = true
			if err := windows.TerminateJobObject(tree.job, 1); err != nil {
				uncertain = true
			}
		}
	}
}
