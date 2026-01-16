import subprocess

# Test 1: Without "with multiple selections allowed"
print("=" * 50)
print("Test 1: Basic folder picker")
print("=" * 50)
script1 = 'POSIX path of (choose folder with prompt "Test basic")'
result1 = subprocess.run(['osascript', '-e', script1], capture_output=True, text=True, timeout=60)
print(f"Return code: {result1.returncode}")
print(f"Stdout: '{result1.stdout.strip()}'")
print(f"Stderr: '{result1.stderr.strip()}'")

# Test 2: With "with multiple selections allowed"
print("\n" + "=" * 50)
print("Test 2: With 'with multiple selections allowed'")
print("=" * 50)
script2 = 'POSIX path of (choose folder with prompt "Test with clause" with multiple selections allowed)'
result2 = subprocess.run(['osascript', '-e', script2], capture_output=True, text=True, timeout=60)
print(f"Return code: {result2.returncode}")
print(f"Stdout: '{result2.stdout.strip()}'")
print(f"Stderr: '{result2.stderr.strip()}'")
