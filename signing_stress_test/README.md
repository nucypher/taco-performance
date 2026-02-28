# Signing Stress Test

A Python-based stress testing tool for Porter signing endpoints. This script simulates 
concurrent signing requests to measure performance metrics such as latency, success rates, 
and statistical distributions.

## Overview

The signing stress test performs multiple concurrent requests to a Porter instance to evaluate:
- Response time distribution (mean, median, min, max, p90, p95)
- Success and failure rates
- Performance under concurrent load

## Requirements

- Dependencies: `click`, `requests`

Install dependencies using:
```bash
pip install -r requirements.txt
```

## Usage

```bash
python signing_stress_test.py --domain <domain> [OPTIONS]
```

### Required Arguments

- `--domain` / `-d`: Porter domain to send signing requests to
  - Choices: `mainnet`, `lynx`

- `--cohort-id`: Cohort ID for the signing requests
  - Choices: `1`, `3`, `4`
    
    _(Note that Cohort 4 is only available for mainnet)_


### Optional Arguments

- `--num-threads` / `-t`: Number of threads to use for concurrent requests
  - Type: `INT`
  - Default: `30`

- `--test-executions` / `-e`: Total number of test executions to perform
  - Type: `INT`
  - Default: `100`

- `--timeout`: Maximum time to wait for all threads to complete (in seconds)
  - Type: `INT`
  - Default: `120`

  - Default: `3`

### Examples

Run a basic stress test with default settings on mainnet:
```bash
python signing_stress_test.py --domain mainnet --cohort-id 4
```

Run with custom parameters:
```bash
python signing_stress_test.py --domain lynx --num-threads 50 --test-executions 200 --cohort-id 1
```

## Output

Example output:
```
[RESULTS]: Node signing stress test with 30 threads and 100 test executions

Total time: 45.23s
Cohort ID: 3
Num failures: 0
Statistics for successful requests: 100
	Mean: 1.45s
	Median: 1.42s
	Max: 2.15s
	Min: 0.98s
	p90: 1.89s
	p95: 2.03s
```

## Performance Tuning

### For Maximum Throughput
- Increase `--num-threads` (e.g., 100-200)
- Increase `--test-executions` accordingly
- Adjust `--timeout` to accommodate longer test duration
