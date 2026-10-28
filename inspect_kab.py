
import sys
sys.stdout.reconfigure(encoding='utf-8')
with open(r'E:\Doğrudan_Temin_Dosya_Girişi.html', 'r', encoding='utf-8') as f:
    lines = f.readlines()
for i in range(1930, 2095):
    print(f'{i+1}: {lines[i]}', end='')
