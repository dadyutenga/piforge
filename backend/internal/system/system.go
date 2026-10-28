package system

import (
	"bufio"
	"context"
	"net"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Point struct {
	At          int64   `json:"at"`
	CPU         float64 `json:"cpu"`
	Memory      float64 `json:"memory"`
	Disk        float64 `json:"disk"`
	Temperature float64 `json:"temperature"`
	RXBytesSec  float64 `json:"rxBytesSec"`
	TXBytesSec  float64 `json:"txBytesSec"`
}

type Interface struct {
	Name      string   `json:"name"`
	Addresses []string `json:"addresses"`
	Up        bool     `json:"up"`
}

type Device struct {
	Hostname    string      `json:"hostname"`
	Model       string      `json:"model"`
	OS          string      `json:"os"`
	Kernel      string      `json:"kernel"`
	Arch        string      `json:"arch"`
	Cores       int         `json:"cores"`
	UptimeSec   float64     `json:"uptimeSec"`
	MemoryBytes uint64      `json:"memoryBytes"`
	DiskBytes   uint64      `json:"diskBytes"`
	DiskUsed    uint64      `json:"diskUsed"`
	Interfaces  []Interface `json:"interfaces"`
}

type Snapshot struct {
	Device               Device  `json:"device"`
	Current              Point   `json:"current"`
	History              []Point `json:"history"`
	TemperatureAvailable bool    `json:"temperatureAvailable"`
	CapturedAt           int64   `json:"capturedAt"`
}

type Sampler struct {
	mu                   sync.RWMutex
	points               []Point
	lastTotal            uint64
	lastIdle             uint64
	lastRX               uint64
	lastTX               uint64
	temperatureAvailable bool
}

func NewSampler(ctx context.Context) *Sampler {
	s := &Sampler{points: make([]Point, 0, 120)}
	s.sample()
	go func() {
		t := time.NewTicker(2 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.sample()
			}
		}
	}()
	return s
}

func readFile(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(strings.TrimRight(string(b), "\x00"))
}

func number(s string) uint64 { n, _ := strconv.ParseUint(s, 10, 64); return n }

func cpuTotals() (uint64, uint64) {
	parts := strings.Fields(strings.SplitN(readFile("/proc/stat"), "\n", 2)[0])
	if len(parts) < 6 {
		return 0, 0
	}
	var total uint64
	for _, v := range parts[1:] {
		total += number(v)
	}
	return total, number(parts[4]) + number(parts[5])
}

func memory() (uint64, uint64) {
	var total, available uint64
	for _, line := range strings.Split(readFile("/proc/meminfo"), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			total = number(fields[1]) * 1024
		case "MemAvailable:":
			available = number(fields[1]) * 1024
		}
	}
	return total, available
}

func disk() (uint64, uint64) {
	var s syscall.Statfs_t
	if syscall.Statfs("/", &s) != nil {
		return 0, 0
	}
	total := s.Blocks * uint64(s.Bsize)
	available := s.Bavail * uint64(s.Bsize)
	return total, total - available
}

func networkBytes() (uint64, uint64) {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	var rx, tx uint64
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 || strings.TrimSpace(parts[0]) == "lo" {
			continue
		}
		v := strings.Fields(parts[1])
		if len(v) >= 9 {
			rx += number(v[0])
			tx += number(v[8])
		}
	}
	return rx, tx
}

func temperature() (float64, bool) {
	v := readFile("/sys/class/thermal/thermal_zone0/temp")
	n, err := strconv.ParseFloat(v, 64)
	return n / 1000, err == nil
}

func (s *Sampler) sample() {
	total, idle := cpuTotals()
	memTotal, memAvail := memory()
	diskTotal, diskUsed := disk()
	rx, tx := networkBytes()
	temp, tempOK := temperature()
	s.mu.Lock()
	defer s.mu.Unlock()
	p := Point{At: time.Now().UnixMilli(), Temperature: temp}
	if total > s.lastTotal {
		p.CPU = float64((total-s.lastTotal)-(idle-s.lastIdle)) * 100 / float64(total-s.lastTotal)
	}
	if memTotal > 0 {
		p.Memory = float64(memTotal-memAvail) * 100 / float64(memTotal)
	}
	if diskTotal > 0 {
		p.Disk = float64(diskUsed) * 100 / float64(diskTotal)
	}
	if s.lastRX > 0 && rx >= s.lastRX {
		p.RXBytesSec = float64(rx-s.lastRX) / 2
	}
	if s.lastTX > 0 && tx >= s.lastTX {
		p.TXBytesSec = float64(tx-s.lastTX) / 2
	}
	s.lastTotal, s.lastIdle, s.lastRX, s.lastTX = total, idle, rx, tx
	s.temperatureAvailable = tempOK
	if len(s.points) == 120 {
		copy(s.points, s.points[1:])
		s.points = s.points[:119]
	}
	s.points = append(s.points, p)
}

func uptime() float64 {
	v := strings.Fields(readFile("/proc/uptime"))
	if len(v) == 0 {
		return 0
	}
	n, _ := strconv.ParseFloat(v[0], 64)
	return n
}

func kernel() string {
	var u syscall.Utsname
	if syscall.Uname(&u) != nil {
		return ""
	}
	var b []byte
	for _, c := range u.Release {
		if c == 0 {
			break
		}
		b = append(b, byte(c))
	}
	return string(b)
}

func interfaces() []Interface {
	all, _ := net.Interfaces()
	out := make([]Interface, 0, len(all))
	for _, i := range all {
		addrs, _ := i.Addrs()
		item := Interface{Name: i.Name, Up: i.Flags&net.FlagUp != 0, Addresses: make([]string, 0, len(addrs))}
		for _, a := range addrs {
			item.Addresses = append(item.Addresses, a.String())
		}
		out = append(out, item)
	}
	return out
}

func (s *Sampler) Snapshot() Snapshot {
	name, _ := os.Hostname()
	memTotal, _ := memory()
	diskTotal, diskUsed := disk()
	osName := "Linux"
	for _, line := range strings.Split(readFile("/etc/os-release"), "\n") {
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			osName = strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), "\"")
			break
		}
	}
	s.mu.RLock()
	history := append([]Point(nil), s.points...)
	tempOK := s.temperatureAvailable
	s.mu.RUnlock()
	current := Point{}
	if len(history) > 0 {
		current = history[len(history)-1]
	}
	return Snapshot{Device: Device{Hostname: name, Model: readFile("/proc/device-tree/model"), OS: osName, Kernel: kernel(), Arch: runtime.GOARCH, Cores: runtime.NumCPU(), UptimeSec: uptime(), MemoryBytes: memTotal, DiskBytes: diskTotal, DiskUsed: diskUsed, Interfaces: interfaces()}, Current: current, History: history, TemperatureAvailable: tempOK, CapturedAt: current.At}
}
