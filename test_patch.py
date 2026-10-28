
with open(r'E:\Doğrudan_Temin_Dosya_Girişi.html', 'r', encoding='utf-8') as f:
    lines = f.readlines()
for i in range(860, 875):
    print(f'{i+1}: {lines[i]}', end='')
