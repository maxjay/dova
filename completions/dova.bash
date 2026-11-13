_dova() { COMPREPLY=($(dova __complete -- "${COMP_WORDS[@]:1:COMP_CWORD}")); }
complete -F _dova dova
