# a hacky smoke test that sends a file from one chrome window to another.
#   docker build -t ww-selenium .
#   docker run --rm -it -v $PWD:$PWD -w $PWD ww-selenium python3 ./smoke.py
# it isn't much but it's start.
# TODO:
#   - use go package / go test
#   - run the server
#   - eventually smoke test *all* client combinations. yes n². i can
#     count 9 clients (command line, firefox, chrome, firefox ext,
#     chrome ext, safari, ios safari, android chrome, android firefox)
#     81 transfers doesn't sound too bad.
#   - add iptable rules to simulate nat/firewall scenarios and test
#     ice.

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
import time
import tempfile
import os
import filecmp
from os import path

indir = tempfile.TemporaryDirectory()
print("in:", indir.name)
outdir = tempfile.TemporaryDirectory()
print("out:", outdir.name)

fpath = path.join(indir.name, "file.bin")
with open(fpath, 'wb') as f:
	f.write(os.urandom(100<<10))

opts = webdriver.ChromeOptions()
opts.headless = True
opts.binary_location = '/usr/bin/chromium'
# because in docker we run as root. TODO fix this.
opts.add_argument("no-sandbox")

opts.add_experimental_option("prefs", {
	"download.default_directory": outdir.name,
	"download.prompt_for_download": False,
	"download.directory_upgrade": True,
	"safebrowsing.enabled": True
})

driver1 = webdriver.Chrome(options=opts)
driver2 = webdriver.Chrome(options=opts)


try:

	driver1.get("https://webwormhole.io")
	driver2.get("https://webwormhole.io")
	
	driver1.find_element(By.ID, 'dial').click()
	WebDriverWait(driver1, 10).until(
		EC.text_to_be_present_in_element((By.ID, "info"), "Waiting for")
	)
	assert driver1.find_element(By.ID, 'info').text.startswith("Waiting for the other")

	code = driver1.find_element(By.ID, 'magiccode').get_attribute("value")
	assert len(code) != 0
	print(code)

	driver2.find_element(By.ID, 'magiccode').send_keys(code)
	driver2.find_element(By.ID, 'dial').click()

	WebDriverWait(driver1, 10).until(
		EC.visibility_of(driver1.find_element(By.ID, "top"))
	)
	WebDriverWait(driver2, 10).until(
		EC.visibility_of(driver2.find_element(By.ID, "top"))
	)

	driver1.find_element(By.ID, 'filepicker').send_keys(fpath)

	time.sleep(3)
	assert filecmp.cmp(fpath, path.join(outdir.name, "file.bin"))

	print("success")

finally:
	driver1.quit()
	driver2.quit()
